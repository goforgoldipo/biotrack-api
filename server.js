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
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

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

    ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id);
    CREATE INDEX IF NOT EXISTS idx_snap_user ON snapshots (user_id, received_at DESC);
  `);
  console.log("  ✓ DB tables ready");
}

// ─────────────────────────────────────────────────────────────────
// STORAGE HELPERS
// ─────────────────────────────────────────────────────────────────

async function dbInsertSnapshot(snap) {
  await pool.query(
    `INSERT INTO snapshots (received_at, sync_date, data) VALUES ($1, $2, $3)`,
    [snap._receivedAt, snap.syncDate || null, JSON.stringify(snap)]
  );
}

async function dbGetLatest() {
  const { rows } = await pool.query(
    `SELECT data FROM snapshots ORDER BY received_at DESC LIMIT 1`
  );
  return rows[0]?.data || null;
}

// Returns raw snapshot rows newest-first, enough to cover `days` unique dates
async function dbGetHistory(days) {
  // Fetch up to days*15 raw rows — plenty of buffer to dedup into `days` unique dates
  const limit = Math.min(days * 15, 50000);
  const { rows } = await pool.query(
    `SELECT data FROM snapshots ORDER BY received_at DESC LIMIT $1`,
    [limit]
  );
  return rows.map(r => r.data);
}

async function dbGetMeta() {
  const { rows } = await pool.query(`SELECT key, value FROM meta`);
  const out = {};
  rows.forEach(r => {
    try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
  });
  return out;
}

async function dbSetMeta(updates) {
  for (const [key, value] of Object.entries(updates)) {
    await pool.query(
      `INSERT INTO meta (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify(value)]
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
app.use(express.json({ limit: "4mb" }));

// ── Auth
function auth(req, res, next) {
  const key = req.headers["x-api-secret"];
  if (!key || key !== SECRET) {
    return res.status(401).json({ error: "Unauthorized — wrong or missing x-api-secret header" });
  }
  next();
}

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

let _daysCache = { at: 0, days: null };
async function loadDays() {
  if (_daysCache.days && Date.now() - _daysCache.at < 5 * 60 * 1000) return _daysCache.days;
  const days = dedupHistory(await dbGetHistory(20000), 20000, true)
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d._dateKey))
    .sort((a, b) => a._dateKey.localeCompare(b._dateKey));
  _daysCache = { at: Date.now(), days };
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
    // Apple Health reports percentages as fractions (0.18) — store as 18 like the rest of BioTrack
    if (d.hkMeta) for (const [k, m] of Object.entries(d.hkMeta)) if (m[0] === "%" && typeof d[k] === "number" && Math.abs(d[k]) <= 1.5) d[k] = Math.round(d[k] * 10000) / 100;
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
  return `You are BioTrack's health and performance coach. The user is asking about their own health data, collected from Apple Health (every app and device on their iPhone: Apple Watch, Hume scale, Fitbod, MyFitnessPal, Oura and others), plus manual uploads. Their goal is to get in the best shape of their life: lower body fat, more lean muscle, better recovery and longevity.

How to answer:
- Ground every claim in their actual numbers. Use get_health_data to look before you answer; pull the ranges you need, compare periods, and spot trends, correlations and outliers. Quote specific values and dates.
- Give the best possible answer, like a world-class coach and sports physician reviewing their data: what's happening, why it likely matters, and exactly what to do next (concrete targets, numbers, and timeframes).
- Use web_search when current research or guidelines would improve the answer, and cite sources briefly.
- Be direct and specific. Lead with the answer, then the evidence. Use short sections or bullets and markdown tables for comparisons. Skip generic disclaimers; if something warrants a doctor, say so plainly in one line.
- If data needed for a question isn't tracked, say which metric is missing and how to start tracking it.

Today is ${today}. Data covers ${days[0]?._dateKey || "?"} to ${last._dateKey || "?"} (${days.length} days).

Metric catalog (key ("label") [unit]: first → last date, days with data). hk_* are Apple Health quantities, hkc_* Apple Health categories (minutes or counts), hkw_* workouts; the rest are BioTrack's named fields (weight lbs, bodyFat %, steps, calories, protein g, hrv ms, restingHR bpm, sleep, Fitbod training volume, body measurements in inches, custom metrics c_*):
${catalog}`;
}

// POST /ask  { messages: [{role:"user"|"assistant", content:string}, ...] }  → text/event-stream
app.post("/ask", auth, async (req, res) => {
  const history = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const messages = history
    .filter(m => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-20)
    .map(m => ({ role: m.role, content: m.content }));
  if (!messages.length || messages[messages.length - 1].role !== "user") return res.status(400).json({ error: "Send a question" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  let closed = false; req.on("close", () => { closed = true; });

  try {
    const { anthropicKey } = await getCoachingSettings();
    if (!anthropicKey) { send({ type: "error", text: "No Anthropic API key is set. Add one in AI Coach settings." }); return res.end(); }
    const client = new AnthropicClient({ apiKey: anthropicKey });
    const days = await loadDays();
    const cat = metricCatalog(days);
    const system = [{ type: "text", text: askSystemPrompt(days, cat), cache_control: { type: "ephemeral" } }];

    for (let turn = 0; turn < 12 && !closed; turn++) {
      const stream = client.beta.messages.stream({
        model: ASK_MODEL,
        max_tokens: 32000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "high" },
        system,
        tools: ASK_TOOLS,
        messages,
      });
      stream.on("text", (t) => { if (!closed) send({ type: "text", text: t }); });
      const msg = await stream.finalMessage();
      messages.push({ role: "assistant", content: msg.content });

      if (msg.stop_reason === "refusal") { send({ type: "text", text: "\n\n_I can't help with that one._" }); break; }
      if (msg.stop_reason === "pause_turn") continue;           // server tool (web search) still running
      if (msg.stop_reason !== "tool_use") break;

      const results = [];
      for (const b of msg.content) {
        if (b.type !== "tool_use" || b.name !== "get_health_data") continue;
        const input = b.input || {};
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
    send({ type: "error", text: msg });
  }
  res.end();
});

// GET /latest
app.get("/latest", auth, async (req, res) => {
  try {
    const latest = await dbGetLatest();
    if (!latest) return res.status(404).json({ error: "No data yet — open BioTrack Health on iPhone and tap Sync Now" });
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
      `SELECT id, data FROM snapshots WHERE sync_date = $1 ORDER BY received_at DESC LIMIT 1`,
      [targetDate]
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
      await pool.query(`UPDATE snapshots SET data = $1 WHERE id = $2`, [JSON.stringify(updated), rows[0].id]);
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
    name: "BioTrack API",
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
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-opus-4-5",
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.content[0].text;
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
      from: `"BioTrack Coach" <${gmailUser}>`,
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
      from: "BioTrack Coach <coach@sellmore.me>",
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
      BioTrack · Your personal health AI · <a href="https://biotrack-dashboard.vercel.app" style="color:#888888">View Dashboard</a>
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
  return {
    anthropicKey: meta.coaching_anthropic_key  || process.env.ANTHROPIC_API_KEY  || null,
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
      await sendPushNotification(titles[session] || "BioTrack Coach", preview, cfg.ntfyTopic);
    }

    // Email — full formatted version
    const subjects = {
      morning: `🌅 BioTrack 5AM Brief — ${nowDate}`,
      midday:  `☀️ BioTrack 12PM Check-In — ${nowDate}`,
      evening: `🌙 BioTrack 5PM Recap — ${nowDate}`,
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

// Lightweight Clerk JWT verification using JWKS
async function verifyClerkJWT(token) {
  if (!token) return null;
  try {
    const [headerB64] = token.split(".");
    const header = JSON.parse(Buffer.from(headerB64, "base64url").toString());
    const kid = header.kid;
    // Fetch JWKS from Clerk
    const clerkDomain = process.env.CLERK_DOMAIN || "";
    if (!clerkDomain) return null;
    const jwksRes = await fetch(`https://${clerkDomain}/.well-known/jwks.json`);
    const { keys } = await jwksRes.json();
    const jwk = keys.find(k => k.kid === kid);
    if (!jwk) return null;
    // Import key and verify
    const { createVerify } = require("crypto");
    const { createPublicKey } = require("crypto");
    const publicKey = createPublicKey({ key: jwk, format: "jwk" });
    const [hdr, payload, sig] = token.split(".");
    const data = `${hdr}.${payload}`;
    const verify = createVerify("RSA-SHA256");
    verify.update(data);
    const valid = verify.verify(publicKey, sig, "base64url");
    if (!valid) return null;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (claims.exp && claims.exp < Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch { return null; }
}

// POST /users/upsert — create or update user from Clerk session
app.post("/users/upsert", async (req, res) => {
  try {
    const authHeader = req.headers["authorization"] || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const claims = await verifyClerkJWT(token);
    // Fallback: allow legacy secret for Brandon's own account migration
    const isLegacy = !claims && req.headers["x-api-secret"] === SECRET;
    if (!claims && !isLegacy) return res.status(401).json({ error: "Unauthorized" });

    const userId = claims ? claims.sub : "legacy_brandon";
    const { username, display_name, is_public, avatar_url } = req.body;

    // Get email from claims
    const email = claims?.email || claims?.primary_email_address || req.body.email || `${userId}@biotrack.app`;

    await pool.query(`
      INSERT INTO users (id, email, username, display_name, avatar_url, is_public)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (id) DO UPDATE SET
        email        = EXCLUDED.email,
        username     = COALESCE(NULLIF(EXCLUDED.username,''), users.username),
        display_name = COALESCE(NULLIF(EXCLUDED.display_name,''), users.display_name),
        avatar_url   = COALESCE(EXCLUDED.avatar_url, users.avatar_url),
        is_public    = EXCLUDED.is_public
    `, [userId, email, username||null, display_name||null, avatar_url||null, is_public||false]);

    const { rows } = await pool.query("SELECT * FROM users WHERE id=$1", [userId]);
    res.json({ ok: true, user: rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /users/me — return own profile
app.get("/users/me", async (req, res) => {
  try {
    const authHeader = req.headers["authorization"] || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const claims = await verifyClerkJWT(token);
    if (!claims) return res.status(401).json({ error: "Unauthorized" });
    const { rows } = await pool.query("SELECT * FROM users WHERE id=$1", [claims.sub]);
    if (!rows.length) return res.status(404).json({ error: "User not found" });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

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
      console.log(`\n⬡ BioTrack API v2.2 — port ${PORT}`);
      console.log(`  Storage: PostgreSQL`);
      console.log(`  SECRET_KEY: set (${SECRET.length} chars)`);
      console.log(`  CORS: ${ALLOWED.join(", ") || "all"}`);

      // ── 3 daily coaching sessions — schedule read from DB so /coaching/settings changes take effect on redeploy
      getCoachingSettings().then(cfg => {
        const cronAM = cfg.cronMorning;
        const cronMD = cfg.cronMidday;
        const cronPM = cfg.cronEvening;
        cron.schedule(cronAM, () => {
          console.log("[cron] morning brief");
          runDailyCoaching("morning");
        }, { timezone: "UTC" });
        cron.schedule(cronMD, () => {
          console.log("[cron] midday check-in");
          runDailyCoaching("midday");
        }, { timezone: "UTC" });
        cron.schedule(cronPM, () => {
          console.log("[cron] evening recap");
          runDailyCoaching("evening");
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
