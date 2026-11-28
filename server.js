// ─────────────────────────────────────────────────────────────────
//  BIOTRACK API  v2.2
//  Receives health snapshots from iOS app → serves to dashboard
//
//  ENV VARS (Railway Variables tab):
//    SECRET_KEY     = <your secret>
//    DATABASE_URL   = (auto-set by Railway when you add PostgreSQL service)
//    PORT           = (auto-set by Railway)
//    ALLOWED_ORIGIN = https://biotrack-dashboard.vercel.app
// ─────────────────────────────────────────────────────────────────

const express = require("express");
const cors    = require("cors");
const crypto  = require("crypto");
const { Pool } = require("pg");

const app    = express();
const PORT   = process.env.PORT || 3000;
const SECRET = process.env.SECRET_KEY || (() => { throw new Error("SECRET_KEY env var required"); })();

// ── PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : false,
});

// ── Accounts: every request runs as one user (tenancy.js)
const Tenancy = require("./tenancy");
const { OWNER, currentUser, runAs } = Tenancy;
let T;   // set once SECRET is known (below)

// ── Create tables on startup (idempotent)
async function dbInit() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id          BIGSERIAL PRIMARY KEY,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sync_date   TEXT,
      data        JSONB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_snap_received ON snapshots (received_at DESC);
    CREATE INDEX IF NOT EXISTS idx_snap_sync_date ON snapshots (sync_date);

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id           TEXT PRIMARY KEY,
      email        TEXT UNIQUE NOT NULL,
      username     TEXT UNIQUE,
      display_name TEXT,
      avatar_url   TEXT,
      is_public    BOOLEAN NOT NULL DEFAULT false,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );

  `);
  await T.migrate();   // users/owner, per-user snapshots + meta, API keys
  console.log("  ✓ DB tables ready");
}

// ─────────────────────────────────────────────────────────────────
// STORAGE HELPERS
// ─────────────────────────────────────────────────────────────────

async function dbInsertSnapshot(snap) {
  await pool.query(
    `INSERT INTO snapshots (received_at, sync_date, data, user_id) VALUES ($1, $2, $3, $4)`,
    [snap._receivedAt, snap.syncDate || null, JSON.stringify(snap), currentUser()]
  );
}

async function dbGetLatest() {
  const { rows } = await pool.query(
    `SELECT data FROM snapshots WHERE user_id = $1 ORDER BY received_at DESC LIMIT 1`, [currentUser()]
  );
  return rows[0]?.data || null;
}

// Returns raw snapshot rows newest-first, enough to cover `days` unique dates
async function dbGetHistory(days) {
  // Fetch up to days*15 raw rows — plenty of buffer to dedup into `days` unique dates
  const limit = Math.min(days * 15, 50000);
  const { rows } = await pool.query(
    `SELECT data FROM snapshots WHERE user_id = $2 ORDER BY received_at DESC LIMIT $1`,
    [limit, currentUser()]
  );
  return rows.map(r => r.data);
}

async function dbGetMeta(uid = currentUser()) {
  const { rows } = await pool.query(`SELECT key, value FROM meta WHERE user_id = $1`, [uid]);
  const out = {};
  rows.forEach(r => {
    try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
  });
  return out;
}

async function dbSetMeta(updates, uid = currentUser()) {
  for (const [key, value] of Object.entries(updates)) {
    await pool.query(
      `INSERT INTO meta (user_id, key, value) VALUES ($3, $1, $2)
       ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify(value), uid]
    );
  }
}

// Dedup history by date (same logic as before — merge fields across same-day syncs)
function dedupHistory(rawSnaps, days, keepDateKey = false) {
  const withDates = rawSnaps.map(snap => {
    let dateKey = "unknown";
    if (snap.syncDate) {
      const hasYear = /\b\d{4}\b/.test(snap.syncDate);
      const now = new Date();
      let parsed;
      if (hasYear) {
        const normed = snap.syncDate.replace(/^([A-Za-z]+\s+\d{1,2})\s+(\d{4})/, "$1, $2");
        parsed = new Date(normed);
      } else {
        parsed = new Date(snap.syncDate + ", " + now.getFullYear());
        if (!isNaN(parsed.getTime()) && parsed > new Date(now.getTime() + 86400000)) {
          parsed.setFullYear(parsed.getFullYear() - 1);
        }
      }
      if (!isNaN(parsed.getTime())) dateKey = parsed.toISOString().slice(0, 10);
    }
    if (dateKey === "unknown" && snap._receivedAt) {
      dateKey = snap._receivedAt.slice(0, 10);
    }
    return { ...snap, _dateKey: dateKey };
  });

  // Sort: iOS app syncs (no _source) before imports, then newest-received first.
  // This ensures real device data always wins over imported historical data.
  withDates.sort((a, b) => {
    const aIsImport = a._source ? 1 : 0;
    const bIsImport = b._source ? 1 : 0;
    if (aIsImport !== bIsImport) return aIsImport - bIsImport; // iOS first
    return (b._receivedAt || "").localeCompare(a._receivedAt || ""); // then newest
  });

  const byDate = {};
  for (const snap of withDates) {
    const key = snap._dateKey;
    if (!byDate[key]) {
      byDate[key] = { ...snap };
    } else {
      for (const [k, v] of Object.entries(snap)) {
        if (k.startsWith("_")) continue;
        if (v !== null && v !== undefined && v !== "" && v !== 0) {
          const existing = byDate[key][k];
          if (existing === null || existing === undefined || existing === "" || existing === 0) {
            byDate[key][k] = v;
          }
        }
      }
    }
  }

  return Object.values(byDate)
    .sort((a, b) => (b._dateKey || "").localeCompare(a._dateKey || ""))
    .slice(0, days)
    .map(({ _dateKey, ...rest }) => keepDateKey ? { ...rest, _dateKey } : rest);
}

// ── CORS
const ALLOWED = [
  process.env.ALLOWED_ORIGIN,
  "https://biotrack-dashboard.vercel.app",
  "https://biotrack.app",
  "http://localhost:5173",
  "http://localhost:3000",
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (ALLOWED.includes(origin)) return cb(null, true);
    // Allow any *.vercel.app preview deployments
    if (origin.endsWith(".vercel.app")) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  methods: ["GET", "POST", "PUT", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-api-secret", "Authorization"],
}));
app.use(express.json({ limit: "25mb" }));   // CSV exports are sent as JSON text

// ── Auth
T = Tenancy({ pool, SECRET });
function auth(req, res, next) { return T.auth(req, res, next); }   // Clerk session, per-user key, or the owner's SECRET
T.routes(app);

// ─────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────

// POST /sync
app.post("/sync", auth, async (req, res) => {
  try {
    const snap = req.body;
    if (!snap || typeof snap !== "object" || Array.isArray(snap)) {
      return res.status(400).json({ error: "Body must be a JSON object" });
    }
    snap._receivedAt = new Date().toISOString();
    snap._id         = crypto.randomUUID();

    await dbInsertSnapshot(snap);

    const count = Object.keys(snap).filter(k => !k.startsWith("_")).length;
    console.log(`[${snap._receivedAt}] ✓ Synced ${snap.syncDate || "?"} ${snap.syncTime || ""} — ${count} fields`);
    res.json({ ok: true, id: snap._id, receivedAt: snap._receivedAt, fieldCount: count });
  } catch (e) {
    console.error("/sync error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// ASK AI — chat with Claude about the user's full health history
// The model gets a catalog of every metric + a tool to pull any metric over any range,
// so 10+ years of data never has to be pasted into the prompt.
// ─────────────────────────────────────────────────────────────────
const Anthropic = require("@anthropic-ai/sdk");
const AnthropicClient = Anthropic.default || Anthropic;
const ASK_MODEL = "claude-opus-5-5";
const Usage = require("./usage")({ pool, AnthropicClient,   // per-user AI cost, free monthly allowance + credits
  notify: async (title, body) => { const c = await runAs(OWNER, () => getCoachingSettings()); await sendPushNotification(title, body, c.ntfyTopic); } });
Usage.routes(app, auth);
const Jobs = require("./jobs")({ pool });   // long AI work (PDF reading) outside the request
Jobs.routes(app, auth);

// Per-user day cache, refreshed the moment that user's data changes
const _dayCaches = new Map();
const _daysCacheReset = () => _dayCaches.delete(currentUser());
async function loadDays() {
  const uid = currentUser();
  const { rows: m } = await pool.query(`SELECT MAX(received_at) AS t, COUNT(*) AS n FROM snapshots WHERE user_id = $1`, [uid]);
  const stamp = `${m[0]?.t?.toISOString?.() || ""}|${m[0]?.n}`;
  const c = _dayCaches.get(uid);
  if (c?.days && c.stamp === stamp) return c.days;
  const days = dedupHistory(await dbGetHistory(20000), 20000, true)
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d._dateKey))
    .sort((a, b) => a._dateKey.localeCompare(b._dateKey));
  if (_dayCaches.size > 200) _dayCaches.delete(_dayCaches.keys().next().value);
  _dayCaches.set(uid, { stamp, days });
  return days;
}

function metricCatalog(days) {
  const cat = {};
  for (const d of days) {
    for (const [k, v] of Object.entries(d)) {
      if (typeof v !== "number" || !isFinite(v) || k.startsWith("_")) continue;
      const c = cat[k] || (cat[k] = { first: d._dateKey, last: d._dateKey, n: 0 });
      c.last = d._dateKey; c.n++;
    }
    if (d.hkMeta) for (const [k, m] of Object.entries(d.hkMeta)) if (cat[k]) { cat[k].unit = m[0]; if (m[2]) cat[k].label = m[2]; }
    // hk_* "%" values arrive already as percents (the iPhone app converts 0.18 → 18), so no rescaling here.
    // A "≤ 1.5 means fraction" guess used to turn real sub-1.5 % walking asymmetry into 50–70 %.
  }
  return cat;
}

function bucketKey(date, g) {
  if (g === "day") return date;
  if (g === "month") return date.slice(0, 7);
  if (g === "year") return date.slice(0, 4);
  const d = new Date(date + "T12:00:00Z"); const dow = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - dow);
  return "wk " + d.toISOString().slice(0, 10);
}

function queryMetrics(days, { metrics = [], start, end, granularity = "day" }) {
  const g = ["day", "week", "month", "year"].includes(granularity) ? granularity : "day";
  const rows = days.filter(d => (!start || d._dateKey >= start) && (!end || d._dateKey <= end));
  const out = {};
  for (const m of metrics.slice(0, 25)) {
    const b = new Map();
    for (const d of rows) {
      const v = d[m]; if (typeof v !== "number" || !isFinite(v)) continue;
      const k = bucketKey(d._dateKey, g); const x = b.get(k) || { sum: 0, n: 0, min: v, max: v };
      x.sum += v; x.n++; x.min = Math.min(x.min, v); x.max = Math.max(x.max, v); b.set(k, x);
    }
    const r = (v) => Math.round(v * 100) / 100;
    out[m] = g === "day"
      ? [...b].map(([k, x]) => [k, r(x.sum)])
      : [...b].map(([k, x]) => ({ period: k, avg: r(x.sum / x.n), min: r(x.min), max: r(x.max), total: r(x.sum), days: x.n }));
    if (g === "day" && out[m].length > 400) out[m] = { note: "Too many daily points — use week or month granularity for this range.", points: out[m].length };
  }
  return { start: start || rows[0]?._dateKey, end: end || rows[rows.length - 1]?._dateKey, granularity: g, data: out };
}

const ASK_TOOLS = [
  {
    name: "get_health_data",
    description: "Fetch the user's recorded values for one or more metrics over a date range. Daily granularity returns [date, value] pairs; week/month/year return avg, min, max, total and days logged per period. Use month or year for multi-year questions, then zoom in. Metric keys must come from the catalog in the system prompt.",
    input_schema: {
      type: "object",
      properties: {
        metrics: { type: "array", items: { type: "string" }, description: "Metric keys from the catalog (max 25)" },
        start: { type: "string", description: "YYYY-MM-DD inclusive" },
        end: { type: "string", description: "YYYY-MM-DD inclusive" },
        granularity: { type: "string", enum: ["day", "week", "month", "year"] },
      },
      required: ["metrics", "granularity"],
      additionalProperties: false,
    },
    strict: true,
  },
  { type: "web_search_20260209", name: "web_search", max_uses: 4 },
];

function askSystemPrompt(days, cat) {
  const today = new Date().toISOString().slice(0, 10);
  const last = days.slice(-1)[0] || {};
  const catalog = Object.entries(cat).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, c]) => `${k}${c.label ? ` ("${c.label}")` : ""}${c.unit ? ` [${c.unit}]` : ""}: ${c.first} → ${c.last}, ${c.n} days`).join("\n");
  return `You are BodyData's health and performance coach. The user is asking about their own health data, collected from Apple Health (every app and device on their iPhone: Apple Watch, Hume scale, Fitbod, MyFitnessPal, Oura and others), plus manual uploads. Their goal is to get in the best shape of their life: lower body fat, more lean muscle, better recovery and longevity.

How to answer:
- Ground every claim in their actual numbers. Use get_health_data to look before you answer; pull the ranges you need, compare periods, and spot trends, correlations and outliers. Quote specific values and dates.
- Give the best possible answer, like a world-class coach and sports physician reviewing their data: what's happening, why it likely matters, and exactly what to do next (concrete targets, numbers, and timeframes).
- Use web_search when current research or guidelines would improve the answer, and cite sources briefly.
- Be direct and specific. Lead with the answer, then the evidence. Use short sections or bullets and markdown tables for comparisons. Skip generic disclaimers; if something warrants a doctor, say so plainly in one line.
- If data needed for a question isn't tracked, say which metric is missing and how to start tracking it.
- Workouts: hkw_src_<app>_count / _minutes are workout sessions per app from Apple Health and are current (e.g. hkw_src_fitbod_* = Fitbod sessions). The fitbod*/workoutVol/vol*/sets*/reps*/max* fields (sets, reps, weights, volume per muscle) only come from a manual Fitbod CSV export, so they stop at the last export date: never conclude the user stopped training from those alone; check hkw_* and hk_activeEnergyBurned first, and mention when the detailed export is stale.

Today is ${today}. Data covers ${days[0]?._dateKey || "?"} to ${last._dateKey || "?"} (${days.length} days).

Metric catalog (key ("label") [unit]: first → last date, days with data). hk_* are Apple Health quantities, hkc_* Apple Health categories (minutes or counts), hkw_* workouts; the rest are BodyData's named fields (weight lbs, bodyFat %, steps, calories, protein g, hrv ms, restingHR bpm, sleep, Fitbod training volume, body measurements in inches, custom metrics c_*):
${catalog}`;
}

// Custom KPI sections (AI-defined KPIs + API / MCP / agent / file sources)
const { parseCSVText: _parseCSV } = require("./importers/fitbod");
const _slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const sections = require("./sections")(app, {
  auth, dbGetMeta, dbSetMeta, dbInsertSnapshot, getCoachingSettings, AnthropicClient, model: ASK_MODEL,
  parseCSVText: _parseCSV, slug: _slug, usage: () => Usage, isoDay: (v) => isoDay(v), invalidate: () => { _daysCacheReset(); },
  loadDays, catalog: metricCatalog, pool, allUsers: () => T.allUsers(), jobs: () => Jobs,
  // Fitbod CSVs keep using the dedicated importer (sets, reps, volume per muscle on the main board)
  importKnownCsv: async (f) => {
    const { headers, records } = parseCSVText(String(f.text || "")); if (!isFitbodCSV(headers)) return null;
    const days = fitbodSnapshots(records), now = new Date().toISOString(), meta = await dbGetMeta();
    const prev = meta.import_fitbod_newest || meta.fitbod_newest_date;   // re-exports hold the whole history: only resend the last 3 days + newer
    const cutoff = prev ? new Date(new Date(prev).getTime() - 3 * 864e5).toISOString().slice(0, 10) : "";
    for (const d of days.filter(x => x.date >= cutoff)) await dbInsertSnapshot({ ...d.snapshot, _receivedAt: now, _id: crypto.randomUUID() });
    _daysCacheReset();
    await dbSetMeta({ import_fitbod_last: now, import_fitbod_newest: days.length ? days[days.length - 1].date : null, import_fitbod_days: days.length, import_fitbod_name: "Fitbod", fitbod_last_import: now, fitbod_newest_date: days.length ? days[days.length - 1].date : null, fitbod_days_imported: days.length });
    return { ok: true, name: "Fitbod workouts", existed: true, days: days.length, stored: days.length, newest: days[days.length - 1]?.date, kpis: 0, profile: "fitbod" };
  },
});

// The agent as a builder: derived metrics, alerts, goals, with undo and approvals
const Builder = require("./builder")(app, { auth, pool, dbGetMeta, dbSetMeta, loadDays, catalog: metricCatalog, S: sections,
  invalidate: () => _daysCacheReset(), allUsers: () => T.allUsers(),
  notify: async (title, body) => {   // the user's own push topic (the env topic is the owner's phone)
    const m = await dbGetMeta(); const topic = m.coaching_ntfy_topic || (currentUser() === OWNER ? process.env.NTFY_TOPIC : null);
    await sendPushNotification(title, body, topic);
  } });

// One-tap OAuth connections (Withings, WHOOP)
const Connectors = require("./connectors")(app, { onSyncError: (uid, p, msg) => Ops?.alert(`connector:${p}`, `${p} sync failing`, `${uid}: ${msg}`), auth, dbGetMeta, dbSetMeta, S: sections, pool, SECRET, invalidate: () => _daysCacheReset(), allUsers: () => T.allUsers() });

// Weekly review (Sunday evening): wins, watch-outs, 3 actions — grounded with the same data tool as Ask
const aiDays = async () => { const b = await sections.noAiKeys(); const days = await loadDays(); return b.size ? days.map(d => { const o = {}; for (const k in d) if (!b.has(k)) o[k] = d[k]; return o; }) : days; };
const Review = require("./review")(app, { auth, dbGetMeta, dbSetMeta, loadDays: aiDays, catalog: metricCatalog, systemPrompt: (d, c) => askSystemPrompt(d, c),
  queryMetrics: (d, i) => queryMetrics(d, i), dataTool: ASK_TOOLS[0], Usage, model: ASK_MODEL, allUsers: () => T.allUsers(),
  getKey: async () => (await getCoachingSettings()).anthropicKey,
  extraPrompt: async () => (await Builder.promptBlock().catch(() => "")) + (await profileApi.promptBlock().catch(() => "")),
  notify: async (title, body) => { const m = await dbGetMeta(); const topic = m.coaching_ntfy_topic || (currentUser() === OWNER ? process.env.NTFY_TOPIC : null); await sendPushNotification(title, body, topic); } });

// Onboarding questionnaire answers + goal, per user
const profileApi = require("./profile")(app, { auth, pool, dbGetMeta, loadDays, dedupHistory });
// Terms/privacy consent (recorded per version) + permanent account deletion
require("./legal")(app, { auth, pool });
require("./measurements")(app, { auth, pool, Usage, model: ASK_MODEL, invalidate: () => _daysCacheReset(), getKey: async () => (await getCoachingSettings()).anthropicKey });
// Backups, owner alerts, invite-only sign-up
const Ops = require("./ops")(app, { auth, pool,
  notify: async (title, body) => { const c = await runAs(OWNER, () => getCoachingSettings()); await sendPushNotification(title, body, c.ntfyTopic); } });
T.setAdmission(Ops.admit);
// Feature requests + bug reports from both apps (push to the owner's ntfy topic when set)
require("./feedback")(app, { auth, pool, userId: profileApi.userId,
  notify: async (title, body) => { const c = await runAs(OWNER, () => getCoachingSettings()); await sendPushNotification(title, body.slice(0, 400), c.ntfyTopic); } });
// Ready-made screens for the native iPhone app (same engine as the web dashboard)
require("./app-api")(app, { auth, pool, dbGetMeta, dbGetHistory, dedupHistory, profileApi });

// POST /ask  { messages: [{role:"user"|"assistant", content:string}, ...] }  → text/event-stream
app.post("/ask", auth, async (req, res) => {
  const history = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const messages = history
    .filter(m => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-20)
    .map(m => ({ role: m.role, content: m.content }));
  if (!messages.length || messages[messages.length - 1].role !== "user") return res.status(400).json({ error: "Send a question" });
  // Optional file on the latest message: PDF report, screenshot, or CSV text
  const att = req.body?.attachment;
  if (att && (att.data || att.text)) {
    const last = messages[messages.length - 1];
    const mt = att.mediaType || "";
    const block = att.data && mt === "application/pdf" ? { type: "document", source: { type: "base64", media_type: mt, data: att.data }, title: String(att.filename || "report.pdf").slice(0, 200) }
      : att.data && /^image\/(png|jpeg|webp|gif)$/.test(mt) ? { type: "image", source: { type: "base64", media_type: mt, data: att.data } }
      : att.text ? { type: "text", text: `Attached file ${String(att.filename || "").slice(0, 200)}:\n${String(att.text).slice(0, 150000)}` } : null;
    if (!block) return res.status(400).json({ error: "Attach a PDF, PNG, JPG, WebP or CSV." });
    last.content = [block, { type: "text", text: last.content }];
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  let closed = false; res.on("close", () => { closed = true; });   // res, not req: req "close" fires once the body is read

  try {
    const { anthropicKey } = await getCoachingSettings();
    if (!anthropicKey) { send({ type: "error", text: "AI is temporarily unavailable. Please try again later." }); return res.end(); }
    await Usage.checkBudget();
    const client = Usage.client(anthropicKey, "ask");
    const days = await aiDays();   // without data the user hasn't allowed AI to read (e.g. WHOOP)
    const cat = metricCatalog(days);
    const system = [{ type: "text", text: askSystemPrompt(days, cat), cache_control: { type: "ephemeral" } }, { type: "text", text: (await sections.promptBlock()) + (await Builder.promptBlock().catch(() => "")) + (await profileApi.promptBlock().catch(() => "")) }];
    const tools = [...ASK_TOOLS, ...sections.tools, ...Builder.tools];

    for (let turn = 0; turn < 12 && !closed; turn++) {
      const stream = client.beta.messages.stream({
        model: ASK_MODEL,
        max_tokens: 32000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "high" },
        system,
        tools,
        messages,
      });
      stream.on("text", (t) => { if (!closed) send({ type: "text", text: t }); });
      const msg = await stream.finalMessage();
      console.log(`[ask] turn ${turn}: stop=${msg.stop_reason} model=${msg.model} blocks=${msg.content.map(b => b.type).join(",")}`);
      messages.push({ role: "assistant", content: msg.content });

      if (msg.stop_reason === "refusal") { send({ type: "text", text: "\n\n_I can't help with that one._" }); break; }
      if (msg.stop_reason === "pause_turn") continue;           // server tool (web search) still running
      if (msg.stop_reason === "max_tokens") { send({ type: "text", text: "\n\n_(Answer cut off — ask me to continue.)_" }); break; }
      if (msg.stop_reason !== "tool_use") break;

      const results = [];
      for (const b of msg.content) {
        if (b.type !== "tool_use") continue;
        const input = b.input || {};
        if (b.name !== "get_health_data") {
          send({ type: "status", text: b.name === "save_kpi_section" ? `Saving section “${input.name || ""}”…` : b.name === "record_values" ? `Recording ${(input.rows || []).length} date(s) of results…`
            : b.name === "create_derived_metric" ? `Building “${input.name || ""}” and calculating it over your history…` : b.name === "set_alert" ? `Setting alert “${input.label || ""}”…` : b.name === "set_goal" ? `Setting goal “${input.label || ""}”…` : "Preparing for your approval…" });
          try {
            const out = await Builder.runTool(b.name, input, (ev) => { if (!closed) send(ev); });
            results.push({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify(out ?? { error: "unknown tool" }), ...(out ? {} : { is_error: true }) });
            if (out) send({ type: "sections" });
          } catch (e) { results.push({ type: "tool_result", tool_use_id: b.id, content: "Error: " + e.message, is_error: true }); }
          continue;
        }
        send({ type: "status", text: `Looking at ${(input.metrics || []).slice(0, 4).join(", ")}${(input.metrics || []).length > 4 ? "…" : ""} (${input.granularity}${input.start ? `, ${input.start} → ${input.end || "today"}` : ""})` });
        try {
          results.push({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify(queryMetrics(days, input)) });
        } catch (e) {
          results.push({ type: "tool_result", tool_use_id: b.id, content: "Error: " + e.message, is_error: true });
        }
      }
      if (!results.length) break;
      messages.push({ role: "user", content: results });
    }
    send({ type: "done" });
  } catch (e) {
    const msg = e instanceof AnthropicClient.AuthenticationError ? "The saved Anthropic API key was rejected. Paste a new one in AI Coach settings."
      : e instanceof AnthropicClient.RateLimitError ? "Rate limited by Anthropic. Try again in a minute."
      : e instanceof AnthropicClient.APIError ? `AI error ${e.status}: ${e.message}` : e.message;
    console.error("/ask error:", e.message);
    send({ type: "error", text: msg, ...(e.code === "credits_needed" ? { code: e.code } : {}) });
  }
  res.end();
});

// ─────────────────────────────────────────────────────────────────
// AUTOMATIONS — file imports (Fitbod + any CSV via AI column mapping),
// data-source monitor, and export reminders
// ─────────────────────────────────────────────────────────────────
const { parseCSVText, isFitbodCSV, fitbodSnapshots } = require("./importers/fitbod");
const { z } = require("zod");
const { zodOutputFormat } = require("@anthropic-ai/sdk/helpers/zod");

const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const MAPPABLE_KEYS = "weight, bodyFat, leanMass, muscleMass, fatMass, bmi, visceralFat, boneMass, bmr, rmr, metabolicAge, waistIn, chestIn, hipsIn, neckIn, shouldersIn, rightBicepIn, leftBicepIn, rightThighIn, leftThighIn, steps, calsBurned, activeMins, avgHR, restingHR, hrv, vo2max, sleepScore, sleepDur (hours), deepSleep, remSleep, lightSleep, readiness, spo2, respiratoryRate, calories, protein, carbs, fat, fiber, sugar, sodium, water (L), workoutVol, workoutDur (min)";

function isoDay(v) {
  const t = String(v || "").trim(); if (!t) return null;
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const us = t.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/);
  if (us) { const y = us[3].length === 2 ? "20" + us[3] : us[3]; return `${y}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`; }
  const d = new Date(t); return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

const CsvMapping = z.object({
  source: z.string().describe("App or device the file came from, e.g. 'Oura', 'Withings', 'Strong'"),
  dateColumn: z.string().describe("Header of the column holding the date or timestamp"),
  columns: z.array(z.object({
    header: z.string(),
    action: z.enum(["metric", "custom", "ignore"]),
    key: z.string().describe("For action=metric: one of the BodyData keys. Otherwise empty."),
    label: z.string().describe("For action=custom: short human label. Otherwise empty."),
    unit: z.string().describe("Unit after conversion, e.g. lbs, %, kcal, min, bpm. Empty if none."),
    multiply: z.number().describe("Factor to convert the raw value to the unit (e.g. kg→lbs 2.20462, seconds→hours 0.000277778, fraction→% 100). 1 if none."),
    aggregate: z.enum(["sum", "avg", "last"]).describe("How to combine several rows on the same day"),
  })),
});

async function aiMapCSV(headers, sample, filename) {
  const { anthropicKey } = await getCoachingSettings();
  if (!anthropicKey) throw new Error("This file format is new to BodyData, and mapping it needs an Anthropic API key (AI Coach settings).");
  await Usage.checkBudget();
  const client = Usage.client(anthropicKey, "csv_map");
  const response = await client.messages.stream({
    model: ASK_MODEL,
    max_tokens: 16000,
    output_config: { effort: "low", format: zodOutputFormat(CsvMapping) },
    messages: [{ role: "user", content:
      `Map this health/fitness export into BodyData daily metrics.\nFile: ${filename}\nHeaders: ${JSON.stringify(headers)}\nFirst rows:\n${sample.map(r => JSON.stringify(r)).join("\n")}\n\n` +
      `Use action=metric with one of these BodyData keys when a column clearly matches (convert units with multiply): ${MAPPABLE_KEYS}.\n` +
      `Use action=custom for any other useful numeric health/fitness column. Use action=ignore for ids, text, notes, and the date column itself.` }],
  }).finalMessage();
  if (!response.parsed_output) throw new Error("AI couldn't map this file's columns.");
  return response.parsed_output;
}

function applyMapping(records, map) {
  const byDay = {};
  for (const r of records) {
    const date = isoDay(r[map.dateColumn]); if (!date) continue;
    const day = byDay[date] || (byDay[date] = {});
    for (const c of map.columns) {
      if (c.action === "ignore") continue;
      const raw = parseFloat(String(r[c.header] ?? "").replace(/[^0-9.\-]/g, ""));
      if (!isFinite(raw)) continue;
      const v = raw * (c.multiply || 1);
      const key = c.action === "metric" ? c.key : "c_" + slug(c.label || c.header);
      const a = day[key] || (day[key] = { sum: 0, n: 0, last: v, agg: c.aggregate });
      a.sum += v; a.n++; a.last = v;
    }
  }
  const defs = {};
  for (const c of map.columns) if (c.action === "custom") defs["c_" + slug(c.label || c.header)] = { l: c.label || c.header, u: c.unit || "" };
  return Object.keys(byDay).sort().map(date => {
    const snap = { syncDate: date, source: map.source + " export" };
    for (const [k, a] of Object.entries(byDay[date])) snap[k] = Math.round((a.agg === "sum" ? a.sum : a.agg === "last" ? a.last : a.sum / a.n) * 100) / 100;
    if (Object.keys(defs).length) snap.customDefs = defs;
    return { date, snapshot: snap };
  });
}

// POST /import/file  { filename, text, all?: bool }
app.post("/import/file", auth, async (req, res) => {
  try {
    const { filename = "upload.csv", text, all } = req.body || {};
    if (typeof text !== "string" || !text.trim()) return res.status(400).json({ error: "Empty file" });
    const { headers, records } = parseCSVText(text);
    if (!headers.length || !records.length) return res.status(400).json({ error: "Couldn't read any rows. Send a CSV export." });

    let source, days;
    if (isFitbodCSV(headers)) { source = "Fitbod"; days = fitbodSnapshots(records); }
    else {
      const meta = await dbGetMeta();
      const sig = slug(headers.join("|")).slice(0, 180);
      let map = meta["import_map_" + sig];
      if (!map) { map = await aiMapCSV(headers, records.slice(0, 5), filename); await dbSetMeta({ ["import_map_" + sig]: map }); }
      source = map.source; days = applyMapping(records, map);
    }
    const key = "import_" + slug(source);
    const meta = await dbGetMeta();
    // Re-exports contain the whole history: only re-send the last 3 days already imported, plus anything newer
    const prevNewest = meta[key + "_newest"] || (source === "Fitbod" ? meta.fitbod_newest_date : null);   // older script stored it here
    const cutoff = !all && prevNewest ? new Date(new Date(prevNewest).getTime() - 3 * 864e5).toISOString().slice(0, 10) : "";
    const fresh = days.filter(d => d.date >= cutoff);
    const now = new Date().toISOString();
    for (const d of fresh) await dbInsertSnapshot({ ...d.snapshot, _receivedAt: now, _id: crypto.randomUUID() });
    _daysCacheReset();
    const newest = days.length ? days[days.length - 1].date : meta[key + "_newest"];
    await dbSetMeta({ [key + "_last"]: now, [key + "_newest"]: newest, [key + "_days"]: days.length, [key + "_name"]: source });
    console.log(`[import] ${source}: ${fresh.length} of ${days.length} days stored (newest ${newest})`);
    res.json({ ok: true, source, daysInFile: days.length, imported: fresh.length, newest, first: days[0]?.date });
  } catch (e) {
    console.error("/import/file error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /sources — every app feeding BioTrack, how, and how fresh
const DETAIL_GAPS = { fitbod: "Apple Health gets each session (time, calories, heart rate). Sets, reps and weights only come from Fitbod's CSV export." };
app.get("/sources", auth, async (req, res) => {
  try {
    const days = await loadDays(); const meta = await dbGetMeta();
    const apps = {};
    for (const d of days) {
      if (!d.hkSources) continue;
      for (const [k, list] of Object.entries(d.hkSources)) for (const name of list) {
        const a = apps[name] || (apps[name] = { name, via: "Apple Health", first: d._dateKey, last: d._dateKey, metrics: new Set() });
        a.last = d._dateKey > a.last ? d._dateKey : a.last; a.metrics.add(k);
      }
    }
    const out = Object.values(apps).map(a => ({ ...a, metrics: a.metrics.size, mode: "automatic", note: DETAIL_GAPS[slug(a.name)] || null }));
    for (const k of Object.keys(meta)) {
      const m = k.match(/^import_(.+)_last$/); if (!m || m[1].startsWith("map_")) continue;
      out.push({ name: (meta[`import_${m[1]}_name`] || m[1]) + " export", via: "File import", last: meta[`import_${m[1]}_newest`], lastImport: meta[k], days: meta[`import_${m[1]}_days`], mode: "manual" });
    }
    if (meta.fitbod_last_import && !out.some(o => /fitbod export/i.test(o.name)))
      out.push({ name: "Fitbod export", via: "File import", last: meta.fitbod_newest_date, lastImport: meta.fitbod_last_import, days: meta.fitbod_days_imported, mode: "manual" });
    const today = new Date().toISOString().slice(0, 10);
    for (const o of out) o.daysSince = o.last ? Math.round((new Date(today) - new Date(o.last)) / 864e5) : null;
    out.sort((a, b) => (a.mode === b.mode ? 0 : a.mode === "manual" ? -1 : 1) || (b.daysSince ?? 0) - (a.daysSince ?? 0));
    res.json({ sources: out, lastPhoneSync: days.filter(d => d.hkMeta).slice(-1)[0]?._dateKey || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /export — everything this user owns (their data export / backup). Streams JSON so large tables don't buffer.
const EXPORT_TABLES = [["snapshots", "user_id"], ["meta", "user_id"], ["user_profiles", "user_id"], ["feedback", "user_id"]];
app.get("/export", auth, async (req, res) => {
  try {
    const uid = currentUser();
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="bodydata-export-${new Date().toISOString().slice(0,10)}.json"`);
    res.write(`{"exportedAt":${JSON.stringify(new Date().toISOString())},"tables":{`);
    for (let t = 0; t < EXPORT_TABLES.length; t++) {
      const [name, col] = EXPORT_TABLES[t];
      res.write(`${t ? "," : ""}${JSON.stringify(name)}:[`);
      let offset = 0, first = true;
      for (;;) {
        const { rows } = await pool.query(`SELECT * FROM ${name} WHERE ${col} = $2 ORDER BY 1 LIMIT 2000 OFFSET $1`, [offset, uid]).catch(() => ({ rows: [] }));
        for (const r of rows) {
          if (name === "meta" && /secret|key|pass|token/i.test(r.key)) continue;   // never export credentials
          res.write((first ? "" : ",") + JSON.stringify(r)); first = false;
        }
        if (rows.length < 2000) break; offset += 2000;
      }
      res.write("]");
    }
    res.end("}}");
  } catch (e) { if (!res.headersSent) res.status(500).json({ error: e.message }); else res.end(); }
});

// GET/POST /prefs — dashboard layout (card order + hidden KPIs), shared by every device
app.get("/prefs", auth, async (req, res) => {
  try { const meta = await dbGetMeta(); const p = await profileApi.getProfile(); res.json({ ...(meta.dashboard_prefs || {}), profile: p.sex || p.birthYear ? { sex: p.sex || null, birthYear: p.birthYear || null } : (meta.dashboard_prefs?.profile || null) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/prefs", auth, async (req, res) => {
  try {
    const { kpiOrder, kpiHidden, profile, benchmarkOptIn } = req.body || {};
    const prev = (await dbGetMeta()).dashboard_prefs || {};
    // Benchmarks: sex + birth year pick the cohort; opt-in decides whether this user counts in crowd stats
    if (profile !== undefined || benchmarkOptIn !== undefined) {
      const p = profile || prev.profile || {};
      const next = { ...prev,
        profile: { sex: ["male", "female"].includes(p.sex) ? p.sex : null, birthYear: Math.min(2015, Math.max(1920, parseInt(p.birthYear) || 0)) || null },
        benchmarkOptIn: benchmarkOptIn === undefined ? !!prev.benchmarkOptIn : !!benchmarkOptIn, updatedAt: new Date().toISOString() };
      await dbSetMeta({ dashboard_prefs: next });
      // keep the per-user profile in step (benchmarks cohort lives there now)
      if (profile) { const cur = await profileApi.getProfile(); await pool.query(`INSERT INTO user_profiles (user_id, data) VALUES ($2, $1) ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`, [JSON.stringify({ ...cur, ...next.profile }), currentUser()]); }
      return res.json({ ok: true, ...next });
    }
    const order = {};
    if (kpiOrder && typeof kpiOrder === "object" && !Array.isArray(kpiOrder))
      for (const [g, ids] of Object.entries(kpiOrder).slice(0, 60))
        if (Array.isArray(ids)) order[String(g).slice(0, 60)] = ids.slice(0, 400).map(x => String(x).slice(0, 120));
    const hidden = Array.isArray(kpiHidden) ? kpiHidden.slice(0, 1000).map(x => String(x).slice(0, 120)) : [];
    const prefs = { ...prev, kpiOrder: order, kpiHidden: hidden, updatedAt: new Date().toISOString() };
    await dbSetMeta({ dashboard_prefs: prefs });
    res.json({ ok: true, ...prefs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET/POST /automations — export reminders the phone schedules as notifications
app.get("/automations", auth, async (req, res) => {
  try { const meta = await dbGetMeta(); res.json({ reminders: meta.automation_reminders || [] }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/automations", auth, async (req, res) => {
  try {
    const list = Array.isArray(req.body?.reminders) ? req.body.reminders : null;
    if (!list) return res.status(400).json({ error: "reminders must be an array" });
    const clean = list.slice(0, 20).map(r => ({
      id: String(r.id || crypto.randomUUID()).slice(0, 40),
      app: String(r.app || "").slice(0, 40),
      title: String(r.title || "").slice(0, 80),
      openURL: /^[a-z][a-z0-9+.-]*:/i.test(r.openURL || "") ? String(r.openURL).slice(0, 200) : "",
      frequency: r.frequency === "daily" ? "daily" : "weekly",
      weekday: Math.min(7, Math.max(1, parseInt(r.weekday) || 1)),   // 1 = Sunday (iOS calendar)
      hour: Math.min(23, Math.max(0, parseInt(r.hour) || 0)),
      minute: Math.min(59, Math.max(0, parseInt(r.minute) || 0)),
      enabled: r.enabled !== false,
    }));
    await dbSetMeta({ automation_reminders: clean });
    res.json({ ok: true, reminders: clean });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /latest
app.get("/latest", auth, async (req, res) => {
  try {
    const latest = await dbGetLatest();
    if (!latest) return res.status(404).json({ error: "No data yet — open BodyData.AI on your iPhone and tap Sync Now" });
    res.json(latest);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /history?days=30
app.get("/history", auth, async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 20000);
    const raw  = await dbGetHistory(days);
    const snapshots = dedupHistory(raw, days);
    res.json({ count: snapshots.length, days, snapshots });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /stats
app.get("/stats", auth, async (req, res) => {
  try {
    const latest = await dbGetLatest();
    if (!latest) return res.status(404).json({ error: "No data yet" });

    const raw  = await dbGetHistory(365);
    const nums = (key) => raw.map(s => s[key]).filter(v => typeof v === "number");
    const avg  = (arr) => arr.length ? +(arr.reduce((a,b) => a+b,0) / arr.length).toFixed(1) : null;

    res.json({
      latest,
      averages: {
        bodyFat:  avg(nums("bodyFat")),
        weight:   avg(nums("weight")),
        steps:    avg(nums("steps")),
        protein:  avg(nums("protein")),
        calories: avg(nums("calories")),
        hrv:      avg(nums("hrv")),
        sleepDur: avg(nums("sleepDuration")),
      },
      totalSnapshots: raw.length,
      lastSync: latest._receivedAt,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Never send stored credentials back over the wire — only whether they are set.
const SENSITIVE_META = /(key|pass|secret|token)/i;
function publicMeta(m) {
  const out = {};
  for (const [k, v] of Object.entries(m || {})) {
    if (SENSITIVE_META.test(k)) out[k + "_set"] = !!v;
    else out[k] = v;
  }
  return out;
}

// GET /meta
app.get("/meta", auth, async (req, res) => {
  try {
    res.json(publicMeta(await dbGetMeta()));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /meta
app.post("/meta", auth, async (req, res) => {
  try {
    const updates = req.body;
    if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
      return res.status(400).json({ error: "Body must be a JSON object" });
    }
    await dbSetMeta(updates);
    const meta = await dbGetMeta();
    console.log(`[meta] updated:`, Object.keys(updates).join(", "));
    res.json({ ok: true, meta: publicMeta(meta) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /nutrition — patch today's (or a specific date's) snapshot with MFP nutrition data.
// Called by the local import-mfp.py script. Creates a new snapshot if none exists for the date.
app.post("/nutrition", auth, async (req, res) => {
  try {
    const body = req.body;
    if (!body || typeof body !== "object") return res.status(400).json({ error: "Body must be JSON object" });

    const targetDate = body.syncDate; // e.g. "Jul 6"
    if (!targetDate) return res.status(400).json({ error: "syncDate required" });

    // Find the most recent snapshot for this date
    const { rows } = await pool.query(
      `SELECT id, data FROM snapshots WHERE sync_date = $1 AND user_id = $2 ORDER BY received_at DESC LIMIT 1`,
      [targetDate, currentUser()]
    );

    const nutritionFields = {
      calories: body.calories,
      protein:  body.protein,
      carbs:    body.carbs,
      fat:      body.fat,
      fiber:    body.fiber,
      sugar:    body.sugar,
      sodium:   body.sodium,
      water:    body.water,
      breakfastCals: body.breakfastCals,
      lunchCals:     body.lunchCals,
      dinnerCals:    body.dinnerCals,
      snackCals:     body.snackCals,
      breakfastTime: body.breakfastTime,
      lunchTime:     body.lunchTime,
      dinnerTime:    body.dinnerTime,
      lastMealTime:  body.lastMealTime,
      mfpMeals:      body.mfpMeals, // full per-meal breakdown JSON
    };
    // Strip undefined fields
    Object.keys(nutritionFields).forEach(k => nutritionFields[k] == null && delete nutritionFields[k]);

    if (rows.length > 0) {
      // Patch existing snapshot
      const existing = rows[0].data;
      const updated  = { ...existing, ...nutritionFields, _nutritionUpdatedAt: new Date().toISOString() };
      await pool.query(`UPDATE snapshots SET data = $1 WHERE id = $2 AND user_id = $3`, [JSON.stringify(updated), rows[0].id, currentUser()]);
      console.log(`[nutrition] Patched ${targetDate} snapshot (id ${rows[0].id}) with ${Object.keys(nutritionFields).length} fields`);
      return res.json({ ok: true, action: "patched", date: targetDate, fields: Object.keys(nutritionFields) });
    } else {
      // No snapshot for this date — create a nutrition-only record
      const snap = {
        ...nutritionFields,
        syncDate: targetDate,
        syncTime: body.syncTime || "imported",
        _receivedAt: new Date().toISOString(),
        _id: crypto.randomUUID(),
        _source: "mfp-import",
      };
      await dbInsertSnapshot(snap);
      console.log(`[nutrition] Created new snapshot for ${targetDate} with ${Object.keys(nutritionFields).length} nutrition fields`);
      return res.json({ ok: true, action: "created", date: targetDate, fields: Object.keys(nutritionFields) });
    }
  } catch (e) {
    console.error("/nutrition error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /health (no auth)

app.get("/health", async (_req, res) => {
  try {
    const { rows } = await pool.query(`SELECT COUNT(*) as total FROM snapshots`);
    res.json({
      status: "ok",
      storage: "postgresql",
      totalSnapshots: parseInt(rows[0].total),
      uptime: Math.round(process.uptime()),
      version: "2.2.0",
    });
  } catch (e) {
    res.status(500).json({ status: "error", error: e.message });
  }
});

// GET /
app.get("/", (_req, res) => {
  res.json({
    name: "BodyData API",
    version: "2.2.0",
    storage: "postgresql",
    routes: {
      "POST /sync":    "iOS app → post HealthKit snapshot [auth]",
      "GET  /latest":  "Dashboard → get latest snapshot [auth]",
      "GET  /history": "Dashboard → get last N days [auth] ?days=30",
      "GET  /stats":   "Dashboard → aggregated averages [auth]",
      "GET  /meta":    "Dashboard → get import metadata [auth]",
      "POST /meta":    "Import scripts → store metadata [auth]",
      "GET  /health":  "Uptime check [public]",
    },
  });
});

// ─────────────────────────────────────────────────────────────────
// COACHING ENGINE — morning brief (5am ET) + evening recap (5pm ET)
//
// ENV VARS (Railway Variables tab) — or set via dashboard → Coaching:
//   ANTHROPIC_API_KEY   = sk-ant-...
//   COACHING_EMAIL      = your@email.com
//   NTFY_TOPIC          = biotrack
//   GMAIL_USER          = brandonbiotrack@gmail.com
//   GMAIL_APP_PASSWORD  = xxxx xxxx xxxx xxxx  (Gmail app password)
//   RESEND_API_KEY      = re_...  (optional alternative to Gmail)
// ─────────────────────────────────────────────────────────────────

const cron       = require("node-cron");
const nodemailer = require("nodemailer");
const { Resend } = require("resend");

async function callClaude(prompt, systemPrompt, key) {
  if (!key) throw new Error("Anthropic API key not configured");
  const msg = await Usage.client(key, "coaching").messages.create({
    model: ASK_MODEL, max_tokens: 8000, output_config: { effort: "low" },
    system: systemPrompt, messages: [{ role: "user", content: prompt }],
  });
  return msg.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
}

async function sendPushNotification(title, body, topic) {
  if (!topic) return;
  await fetch(`https://ntfy.sh/${topic}`, {
    method: "POST",
    headers: {
      "Title": title,
      "Priority": "default",
      "Tags": "muscle,chart_with_upwards_trend",
      "Content-Type": "text/plain",
    },
    body,
  }).catch(e => console.warn("Push notification failed:", e.message));
}

async function sendCoachingEmail(subject, htmlContent, textContent, cfg) {
  const { email: toEmail, resendKey, gmailUser, gmailPass } = cfg;
  if (!toEmail) { console.log("  ℹ Email not configured (no COACHING_EMAIL)"); return; }

  // Gmail SMTP preferred (free, no account setup beyond app password)
  if (gmailUser && gmailPass) {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: gmailUser, pass: gmailPass },
    });
    await transporter.sendMail({
      from: `"BodyData" <${gmailUser}>`,
      to: toEmail,
      subject,
      html: htmlContent,
      text: textContent,
    });
    console.log(`  ✉ Email sent via Gmail → ${toEmail}`);
    return;
  }

  // Resend fallback
  if (resendKey) {
    const resend = new Resend(resendKey);
    await resend.emails.send({
      from: "BodyData <coach@sellmore.me>",
      to: toEmail,
      subject,
      html: htmlContent,
      text: textContent,
    });
    console.log(`  ✉ Email sent via Resend → ${toEmail}`);
    return;
  }

  console.log("  ℹ Email skipped — no Gmail app password or Resend key configured");
}

function buildDataContext(snapshots) {
  const today = snapshots[0] || {};
  const fmt = (v, unit="") => v != null ? `${typeof v === "number" ? v.toFixed(1) : v}${unit}` : "—";
  const avg = (key, days = snapshots.length) => {
    const vals = snapshots.slice(0, days).map(s => s[key]).filter(v => typeof v === "number");
    return vals.length ? (vals.reduce((a,b) => a+b,0) / vals.length).toFixed(1) : "—";
  };

  // BF trend: first vs last available reading
  const bfReadings = snapshots.filter(s => s.bodyFat != null);
  const bfChange = bfReadings.length >= 2
    ? (bfReadings[0].bodyFat - bfReadings[bfReadings.length - 1].bodyFat).toFixed(2)
    : null;
  const bfCurrent = today.bodyFat;
  const bfTarget = 10;
  const weeksToGoal = bfCurrent != null && bfChange != null && parseFloat(bfChange) > 0
    ? Math.ceil((bfCurrent - bfTarget) / (parseFloat(bfChange) / (bfReadings.length / 7))).toString()
    : "unknown";

  // Weekly averages for trend
  const week1 = snapshots.slice(0, 7);
  const week2 = snapshots.slice(7, 14);
  const weekAvg = (arr, key) => {
    const vals = arr.map(s => s[key]).filter(v => typeof v === "number");
    return vals.length ? (vals.reduce((a,b)=>a+b,0)/vals.length).toFixed(1) : "—";
  };

  // Field aliases — handle both old and new field names
  const activeCal  = today.activeCalories ?? today.calsBurned ?? null;
  const totalBurn  = today.totalCaloriesBurned ?? (activeCal != null && today.basalCalories != null ? activeCal + today.basalCalories : activeCal);
  const sleepHours = today.sleepDuration ?? today.sleepDur ?? null;

  // Calorie deficit estimate (total burn - consumed)
  const netCal = (totalBurn != null && today.calories != null)
    ? (totalBurn - today.calories).toFixed(0)
    : null;

  // avg helper that checks both field name variants
  const avgDual = (key1, key2, days = snapshots.length) => {
    const vals = snapshots.slice(0, days).map(s => s[key1] ?? s[key2]).filter(v => typeof v === "number");
    return vals.length ? (vals.reduce((a,b) => a+b,0) / vals.length).toFixed(1) : "—";
  };

  return `
ATHLETE PROFILE: Brandon Bornancin
PRIMARY GOAL: Reach 10% body fat (currently ${fmt(bfCurrent,"%")} BF — ${bfCurrent != null ? (bfCurrent - bfTarget).toFixed(1) : "?"} points to go)
DIET: Vegan, whole food plant-based
LAST SYNC: ${today.syncDate || "unknown"}
ESTIMATED WEEKS TO 10% BF (at current pace): ${weeksToGoal}

━━ TODAY'S METRICS ━━
Weight:       ${fmt(today.weight," lbs")}    |  Body Fat:    ${fmt(today.bodyFat,"%")}
Lean Mass:    ${fmt(today.leanMass," lbs")}  |  Fat Mass:    ${fmt(today.fatMass," lbs")}
HRV:          ${fmt(today.hrv," ms")}        |  Resting HR:  ${fmt(today.restingHR," bpm")}
Sleep:        ${fmt(sleepHours,"h")}         |  Deep Sleep:  ${fmt(today.deepSleep," min")}
Steps:        ${fmt(today.steps)}            |  Total Burn:  ${fmt(totalBurn," kcal")}
Calories In:  ${fmt(today.calories," kcal")} |  Protein:     ${fmt(today.protein,"g")}
Carbs:        ${fmt(today.carbs,"g")}        |  Fat:         ${fmt(today.fat,"g")}
Water:        ${fmt(today.water," oz")}      |  Net Cal:     ${netCal != null ? netCal + " kcal" : "—"}
Workout Vol:  ${fmt(today.workoutVol," lbs")} | Duration:   ${fmt(today.workoutDur," min")}
VO2 Max:      ${fmt(today.vo2max)}           |  SpO2:        ${fmt(today.spo2,"%")}

━━ 7-DAY vs 30-DAY AVERAGES ━━
                  7-Day Avg   |  30-Day Avg
Weight:           ${avg("weight",7)} lbs    |  ${avg("weight")} lbs
Body Fat:         ${avg("bodyFat",7)}%      |  ${avg("bodyFat")}%
HRV:              ${avg("hrv",7)} ms        |  ${avg("hrv")} ms
Sleep:            ${avgDual("sleepDuration","sleepDur",7)}h  |  ${avgDual("sleepDuration","sleepDur")}h
Steps:            ${avg("steps",7)}         |  ${avg("steps")}
Protein:          ${avg("protein",7)}g      |  ${avg("protein")}g
Calories In:      ${avg("calories",7)} kcal |  ${avg("calories")} kcal
Total Cal Burn:   ${avgDual("totalCaloriesBurned","activeCalories",7)} kcal | ${avgDual("totalCaloriesBurned","activeCalories")} kcal

━━ WEEK-OVER-WEEK TREND ━━
This week vs last week:
  BF%:      ${weekAvg(week1,"bodyFat")}% → ${weekAvg(week2,"bodyFat")}% (prev)
  Weight:   ${weekAvg(week1,"weight")} lbs → ${weekAvg(week2,"weight")} lbs (prev)
  Protein:  ${weekAvg(week1,"protein")}g → ${weekAvg(week2,"protein")}g (prev)
  Steps:    ${weekAvg(week1,"steps")} → ${weekAvg(week2,"steps")} (prev)
  HRV:      ${weekAvg(week1,"hrv")} ms → ${weekAvg(week2,"hrv")} ms (prev)

━━ LAST 14 DAYS (daily) ━━
${snapshots.slice(0,14).map(s => {
  const sl = s.sleepDuration ?? s.sleepDur;
  return `  ${(s.syncDate||"").padEnd(12)} W:${fmt(s.weight,"lbs").padEnd(10)} BF:${fmt(s.bodyFat,"%").padEnd(7)} HRV:${fmt(s.hrv,"ms").padEnd(8)} Sleep:${sl != null ? sl.toFixed(1)+"h" : "—"} Steps:${fmt(s.steps).padEnd(7)} Pro:${fmt(s.protein,"g")} Cal:${fmt(s.calories,"kcal")}`;
}).join("\n")}
`.trim();
}

function buildEmailHtml(coachingText, today) {
  const bf = today.bodyFat != null ? today.bodyFat.toFixed(1) : "—";
  const w  = today.weight  != null ? today.weight.toFixed(1)  : "—";
  const hrv = today.hrv    != null ? today.hrv.toFixed(0)     : "—";
  const paragraphs = coachingText
    .split(/\n\n+/)
    .map(p => `<p style="margin:0 0 16px;line-height:1.7;color:#e8e8e8">${p.replace(/\n/g,"<br>").replace(/\*\*([^*]+)\*\*/g,"<strong style='color:#ffffff'>$1</strong>").replace(/^#{1,3}\s+(.+)$/gm, "<strong style='color:#ffffff'>$1</strong>")}</p>`)
    .join("");

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"><style>:root{color-scheme:dark}body{color-scheme:dark}</style></head><body style="margin:0;padding:0;background:#000000;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color-scheme:dark">
  <div style="max-width:640px;margin:0 auto;padding:32px 24px;background:#000000">
    <div style="text-align:center;margin-bottom:32px">
      <div style="font-size:24px;font-weight:900;color:#ffffff;letter-spacing:3px">⬡ BIOTRACK</div>
      <div style="font-size:12px;color:#666666;letter-spacing:2px;margin-top:4px">DAILY COACHING BRIEF</div>
    </div>
    <div style="display:flex;gap:12px;margin-bottom:28px;justify-content:center">
      ${[["⚖️","Weight",w+" lbs"],["🔥","Body Fat",bf+"%"],["🧬","HRV",hrv+" ms"]].map(([icon,label,val])=>`
      <div style="flex:1;background:#111111;border:1px solid #333333;border-radius:10px;padding:16px;text-align:center;min-width:100px">
        <div style="font-size:22px">${icon}</div>
        <div style="font-size:18px;font-weight:700;color:#ffffff;margin:4px 0">${val}</div>
        <div style="font-size:10px;color:#666666;letter-spacing:1px">${label.toUpperCase()}</div>
      </div>`).join("")}
    </div>
    <div style="background:#111111;border:1px solid #222222;border-radius:12px;padding:24px;margin-bottom:24px">
      ${paragraphs}
    </div>
    <div style="text-align:center;font-size:11px;color:#444444;padding-top:16px;border-top:1px solid #222222">
      BodyData · Your personal health AI · <a href="https://biotrack-dashboard.vercel.app" style="color:#888888">View Dashboard</a>
    </div>
  </div>
</body></html>`;
}

// Brandon's hard goals — used in every coaching prompt so Claude always knows the targets
const BRANDON_GOALS = `
HARD GOALS (non-negotiable targets):
• Body Fat: reach 10% BF (currently ~15-16%) — primary goal
• Steps: 10,000+ steps every day
• Protein: 180g+ per day (vegan — must hit this to preserve lean mass)
• Calories: deficit days ~2,200 kcal, maintenance ~2,600 kcal (adjust based on training)
• Sleep: 7.5h+ per night minimum
• Training: 5 sessions/week, progressive overload
• HRV: maintain above 60ms — below = recovery day
• Water: 100+ oz/day
• Weight loss pace: 0.5-1 lb/week (preserve muscle, lose only fat)
`.trim();

async function getCoachingSettings() {
  const meta = await dbGetMeta();
  // The Anthropic key is BodyData's own (system-wide): env, else the owner's saved setting
  const sys = currentUser() === OWNER ? meta : await dbGetMeta(OWNER);
  return {
    anthropicKey: sys.coaching_anthropic_key || process.env.ANTHROPIC_API_KEY || null,
    email:        meta.coaching_email          || process.env.COACHING_EMAIL      || null,
    resendKey:    meta.coaching_resend_key     || process.env.RESEND_API_KEY      || null,
    gmailUser:    meta.coaching_gmail_user     || process.env.GMAIL_USER          || null,
    gmailPass:    meta.coaching_gmail_pass     || process.env.GMAIL_APP_PASSWORD  || null,
    ntfyTopic:    meta.coaching_ntfy_topic     || process.env.NTFY_TOPIC          || null,
    enabled:      meta.coaching_enabled !== "false",
    // 3 daily crons (UTC): 5am ET = 9 UTC, 12pm ET = 16 UTC, 5pm ET = 21 UTC
    cronMorning:  meta.coaching_cron_morning   || process.env.COACHING_CRON_AM   || "0 9 * * *",
    cronMidday:   meta.coaching_cron_midday    || process.env.COACHING_CRON_MD   || "0 17 * * *",
    cronEvening:  meta.coaching_cron_evening   || process.env.COACHING_CRON_PM   || "0 22 * * *",
  };
}

// POST /coaching/settings — save from dashboard UI (auth required)
app.post("/coaching/settings", auth, async (req, res) => {
  try {
    const { anthropicKey, email, resendKey, gmailUser, gmailPass, ntfyTopic, enabled, cronMorning, cronMidday, cronEvening } = req.body;
    const updates = {};
    if (anthropicKey  !== undefined) updates.coaching_anthropic_key = anthropicKey;
    if (email         !== undefined) updates.coaching_email         = email;
    if (resendKey     !== undefined) updates.coaching_resend_key    = resendKey;
    if (gmailUser     !== undefined) updates.coaching_gmail_user    = gmailUser;
    if (gmailPass     !== undefined) updates.coaching_gmail_pass    = gmailPass;
    if (ntfyTopic     !== undefined) updates.coaching_ntfy_topic    = ntfyTopic;
    if (enabled       !== undefined) updates.coaching_enabled       = String(enabled);
    if (cronMorning   !== undefined) updates.coaching_cron_morning  = cronMorning;
    if (cronMidday    !== undefined) updates.coaching_cron_midday   = cronMidday;
    if (cronEvening   !== undefined) updates.coaching_cron_evening  = cronEvening;
    await dbSetMeta(updates);
    console.log("[coaching/settings] Updated:", Object.keys(updates).join(", "));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /coaching/settings — load for dashboard UI (auth required, keys masked)
app.get("/coaching/settings", auth, async (req, res) => {
  try {
    const s = await getCoachingSettings();
    res.json({
      anthropicKeySet: !!s.anthropicKey,
      anthropicKeyHint: s.anthropicKey ? "sk-ant-…" + s.anthropicKey.slice(-4) : null,
      email:        s.email      || null,
      resendKeySet: !!s.resendKey,
      gmailUser:    s.gmailUser  || null,
      gmailPassSet: !!s.gmailPass,
      ntfyTopic:    s.ntfyTopic  || null,
      enabled:      s.enabled,
      cronMorning:  s.cronMorning,
      cronMidday:   s.cronMidday,
      cronEvening:  s.cronEvening,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

function buildSessionPrompt(session, dataCtx, today) {
  const goals = BRANDON_GOALS;
  const bf    = today && today.bodyFat != null ? today.bodyFat.toFixed(1) : "unknown";
  const steps = today && today.steps   != null ? Math.round(today.steps)  : 0;
  const stepsNeeded = Math.max(0, 10000 - steps);

  if (session === "morning") return `${dataCtx}

${goals}

🌅 5AM MORNING BRIEF — set Brandon up to WIN today and move toward 10% BF:
1. **Readiness Score** — HRV / sleep / resting HR → score Green (train hard), Yellow (moderate), or Red (recover only). Cite exact numbers and what they mean for today.
2. **10% BF Roadmap Check** — he is currently at ${bf}% BF. At this week's pace (use the week-over-week trend), how many weeks to reach 10%? Is he ahead or behind the 0.5-1 lb/week fat loss target?
3. **Today's Training Plan** — train or rest? If train: which muscle groups, how heavy, target volume. Optimal time window given HRV.
4. **Nutrition Blueprint** — exact calorie target, exact protein target (in grams). What to eat for breakfast RIGHT NOW to front-load protein. Specific vegan foods/combos to hit 180g today.
5. **#1 Lever to Pull Today** — the single highest-impact action in the next hour that directly accelerates getting to 10% BF.

Under 500 words. Data-specific. No fluff.`;

  if (session === "midday") return `${dataCtx}

${goals}

☀️ 12PM MIDDAY CHECK-IN — is Brandon on pace RIGHT NOW?
1. **Steps Audit** — today's data shows ${steps} steps logged as of last sync. He needs 10,000. That means ${stepsNeeded} more steps today. Is he on pace? How many steps/hour does he need for the rest of the day?
2. **Protein/Calorie Status** — based on today's logged intake vs his 30-day pattern, estimate where he is right now. What should he eat for lunch RIGHT NOW to stay on track? Specific vegan meal.
3. **HRV & Energy Read** — how is his recovery/energy holding today based on morning HRV and sleep? Any adjustments to afternoon plans?
4. **Afternoon Training Window** — should he train this afternoon? If yes: exact workout (exercise, sets, reps). If no: why not and what to do instead.
5. **10% BF: Today's Make-or-Break** — what is the ONE thing he can do between now and 5pm that most directly moves the needle toward 10% BF?

Be direct. Is today a fat-loss day or a fat-gain day based on current trajectory?`;

  return `${dataCtx}

${goals}

🌙 5PM EVENING PERFORMANCE REVIEW — grade the day, lock in tomorrow:
1. **Daily Scorecard** — grade each metric A/B/C/D/F with the actual number vs target:
   - Steps: ${steps} vs 10,000
   - Protein: vs 180g
   - Calories: vs 2,200 (deficit) or 2,600 (maintenance)
   - Sleep last night: vs 7.5h
   - Training: completed or skipped
   - Overall day grade for BF progress
2. **Body Comp Impact** — based on today's calorie balance and activity, was today a fat-burning day or not? Estimate how much fat (oz or grams) was lost or gained today. How does this affect the weeks-to-10% timeline?
3. **Tonight's Recovery Protocol** — exact bedtime to target, any evening meal (what + macros), wind-down actions to maximize HRV tomorrow.
4. **Tomorrow Pre-loaded** — based on today's data gaps and wins, tomorrow's exact plan: train or rest, calorie target, protein target, step strategy, one priority.
5. **Weekly Progress Verdict** — current BF is ${bf}%. Use the 7-day trend to project: is he on track for 10% within a reasonable timeframe? What single habit change would most accelerate the timeline?

Brutally honest. No participation trophies. Name exactly what went wrong and how to fix it.`;
}

async function runDailyCoaching(session = "morning") {
  const cfg = await getCoachingSettings();
  if (!cfg.anthropicKey) { console.log("[coaching] Skipping — Anthropic API key not configured"); return; }
  if (!cfg.enabled)       { console.log("[coaching] Skipping — coaching disabled"); return; }

  console.log(`[coaching] Running ${session} brief...`);
  try {
    const raw = await dbGetHistory(30);
    const snapshots = dedupHistory(raw, 30);
    if (!snapshots.length) { console.log("[coaching] No data"); return; }

    const today = snapshots[0];
    const dataCtx = buildDataContext(snapshots);

    // Always use the real current date for titles/subjects — never the stale syncDate from data
    const nowDate = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric" });

    const systemPrompt = `You are Brandon Bornancin's personal elite performance coach specializing in body recomposition. Brandon is a vegan founder with one mission: get from ~15-16% body fat to 10% while preserving lean mass. You have 30 days of his biometric data. You are direct, specific, and data-driven — not a generic chatbot. Every response references exact numbers from his data. You speak in a tone that is intense, results-focused, and motivating. Under 600 words. Use **bold** for key numbers and action items. Use markdown tables where helpful for scorecards. Today's date is ${nowDate}.`;

    const userPrompt = buildSessionPrompt(session, dataCtx, today);
    const coaching = await callClaude(userPrompt, systemPrompt, cfg.anthropicKey);
    console.log(`[coaching] Claude ${session} response received`);

    // ntfy push — title + 200-char preview
    if (cfg.ntfyTopic) {
      const preview = coaching.split("\n").filter(l => l.trim()).slice(0, 3).join(" ").slice(0, 200);
      const titles = {
        morning: `🌅 5AM Brief — ${nowDate}`,
        midday:  `☀️ 12PM Check-In — ${nowDate}`,
        evening: `🌙 5PM Recap — ${nowDate}`,
      };
      await sendPushNotification(titles[session] || "BodyData Coach", preview, cfg.ntfyTopic);
    }

    // Email — full formatted version
    const subjects = {
      morning: `🌅 BodyData 5AM Brief — ${nowDate}`,
      midday:  `☀️ BodyData 12PM Check-In — ${nowDate}`,
      evening: `🌙 BodyData 5PM Recap — ${nowDate}`,
    };
    await sendCoachingEmail(subjects[session], buildEmailHtml(coaching, today), coaching, cfg);

    // Persist in DB
    await dbSetMeta({
      [`last_coaching_brief_${session}`]: coaching,
      [`last_coaching_date_${session}`]:  new Date().toISOString(),
      last_coaching_brief: coaching,
      last_coaching_date:  new Date().toISOString(),
    });

    console.log(`[coaching] ✓ ${session} brief complete`);
  } catch(e) {
    console.error("[coaching] Error:", e.message);
  }
}

// POST /coaching/run — manually trigger (auth required). ?session=morning|evening
app.post("/coaching/run", auth, async (req, res) => {
  // The 3x-daily coaching prompts are written for the owner's own goals; other users get the weekly review
  if (req.userId !== OWNER) return res.status(403).json({ error: "Daily coaching isn't available yet. Your weekly review is in Ask AI." });
  try {
    const session = req.query.session || req.body.session || "morning";
    await runDailyCoaching(session);
    const meta = await dbGetMeta();
    res.json({ ok: true, session, brief: meta.last_coaching_brief, date: meta.last_coaching_date });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /coaching/latest — get last brief(s) (auth required)
app.get("/coaching/latest", auth, async (req, res) => {
  try {
    const meta = await dbGetMeta();
    res.json({
      brief:          meta.last_coaching_brief          || null,
      date:           meta.last_coaching_date           || null,
      morningBrief:   meta.last_coaching_brief_morning  || null,
      morningDate:    meta.last_coaching_date_morning   || null,
      middayBrief:    meta.last_coaching_brief_midday   || null,
      middayDate:     meta.last_coaching_date_midday    || null,
      eveningBrief:   meta.last_coaching_brief_evening  || null,
      eveningDate:    meta.last_coaching_date_evening   || null,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// USER / COMMUNITY ROUTES  (multi-user support)
// ─────────────────────────────────────────────────────────────────

// Sign-in (Clerk sessions, per-user keys) lives in tenancy.js: GET /me, /keys.

// GET /community — list all public users + their latest snapshot summary
app.get("/community", async (_req, res) => {
  try {
    const { rows: users } = await pool.query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url,
              s.data as latest
       FROM users u
       LEFT JOIN LATERAL (
         SELECT data FROM snapshots
         WHERE user_id = u.id
         ORDER BY received_at DESC LIMIT 1
       ) s ON true
       WHERE u.is_public = true AND u.username IS NOT NULL
       ORDER BY u.created_at DESC`
    );
    res.json({ users });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /community/leaderboard?metric=hrv&range=30d
app.get("/community/leaderboard", async (req, res) => {
  try {
    const metric = req.query.metric || "hrv";
    const days = req.query.range === "7d" ? 7 : req.query.range === "90d" ? 90 : 30;
    const since = new Date(Date.now() - days * 86400000).toISOString();

    // Get average of metric over period for each public user
    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url,
              AVG((s.data->$1)::numeric) as metric_avg,
              (SELECT data FROM snapshots WHERE user_id=u.id ORDER BY received_at DESC LIMIT 1) as latest
       FROM users u
       JOIN snapshots s ON s.user_id = u.id
       WHERE u.is_public = true
         AND u.username IS NOT NULL
         AND s.received_at >= $2
         AND s.data->$1 IS NOT NULL
       GROUP BY u.id, u.username, u.display_name, u.avatar_url
       ORDER BY metric_avg DESC`,
      [metric, since]
    );
    // Add metric value to latest for display
    const users = rows.map(r => ({
      id: r.id, username: r.username, display_name: r.display_name, avatar_url: r.avatar_url,
      latest: { ...(r.latest||{}), [metric]: r.metric_avg ? +parseFloat(r.metric_avg).toFixed(2) : null }
    }));
    res.json({ metric, range: req.query.range||"30d", users });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /community/:username — public profile data
app.get("/community/:username", async (req, res) => {
  try {
    const { rows: userRows } = await pool.query(
      "SELECT * FROM users WHERE username=$1 AND is_public=true", [req.params.username]
    );
    if (!userRows.length) return res.status(404).json({ error: "Profile not found" });
    const user = userRows[0];

    const { rows: snapRows } = await pool.query(
      `SELECT data FROM snapshots WHERE user_id=$1 ORDER BY received_at DESC LIMIT 365`,
      [user.id]
    );
    const history = snapRows.map(r => r.data);
    const latest = history[0] || null;

    res.json({ user: { id: user.id, username: user.username, display_name: user.display_name, avatar_url: user.avatar_url }, latest, history, groups: [] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.use((_req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, _req, res, _next) => {
  console.error(err.message);
  res.status(500).json({ error: err.message });
});

// ── Start
dbInit()
  .then(() => {
    app.listen(PORT, () => {
      Jobs.start();
      console.log(`\n⬡ BodyData API v2.2 — port ${PORT}`);
      console.log(`  Storage: PostgreSQL`);
      console.log(`  SECRET_KEY: set (${SECRET.length} chars)`);
      console.log(`  CORS: ${ALLOWED.join(", ") || "all"}`);

      // ── 3 daily coaching sessions — schedule read from DB so /coaching/settings changes take effect on redeploy
      // Coaching emails/pushes are the owner's personal setup (per-user coaching comes with accounts)
      runAs(OWNER, () => getCoachingSettings()).then(cfg => {
        const cronAM = cfg.cronMorning;
        const cronMD = cfg.cronMidday;
        const cronPM = cfg.cronEvening;
        cron.schedule(cronAM, () => {
          console.log("[cron] morning brief");
          runAs(OWNER, () => runDailyCoaching("morning"));
        }, { timezone: "UTC" });
        cron.schedule(cronMD, () => {
          console.log("[cron] midday check-in");
          runAs(OWNER, () => runDailyCoaching("midday"));
        }, { timezone: "UTC" });
        cron.schedule(cronPM, () => {
          console.log("[cron] evening recap");
          runAs(OWNER, () => runDailyCoaching("evening"));
        }, { timezone: "UTC" });
        console.log(`  🌅 Morning brief:    ${cronAM} UTC`);
        console.log(`  ☀️  Midday check-in: ${cronMD} UTC`);
        console.log(`  🌙 Evening recap:    ${cronPM} UTC`);
        console.log();
      });
    });
  })
  .catch(e => {
    console.error("Fatal startup error:", e.message);
    process.exit(1);
  });

module.exports = app;
