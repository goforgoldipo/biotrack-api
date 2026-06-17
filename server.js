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
function dedupHistory(rawSnaps, days) {
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
    .map(({ _dateKey, ...rest }) => rest);
}

// ── CORS
const ALLOWED = [
  process.env.ALLOWED_ORIGIN,
  "http://localhost:5173",
  "http://localhost:3000",
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (ALLOWED.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-api-secret"],
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

// GET /meta
app.get("/meta", auth, async (req, res) => {
  try {
    res.json(await dbGetMeta());
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
    res.json({ ok: true, meta });
  } catch (e) {
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
      from: "BioTrack Coach <onboarding@resend.dev>",
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
  const avg = (key) => {
    const vals = snapshots.map(s => s[key]).filter(v => typeof v === "number");
    return vals.length ? (vals.reduce((a,b) => a+b,0) / vals.length).toFixed(1) : "—";
  };

  return `
ATHLETE PROFILE: Brandon Bornancin
PRIMARY GOAL: Reach 10% body fat while preserving lean mass. Currently at ${fmt(today.bodyFat,"%")} BF.
DIET: Vegan, whole food plant-based
LAST SYNC: ${today.syncDate || "unknown"}

━━ TODAY'S METRICS ━━
Weight:       ${fmt(today.weight," lbs")}   |  Body Fat:    ${fmt(today.bodyFat,"%")}
Lean Mass:    ${fmt(today.leanMass," lbs")} |  Fat Mass:    ${fmt(today.fatMass," lbs")}
HRV:          ${fmt(today.hrv," ms")}       |  Resting HR:  ${fmt(today.restingHR," bpm")}
Sleep:        ${fmt(today.sleepDur,"h")}    |  Deep Sleep:  ${fmt(today.deepSleep," min")}
Steps:        ${fmt(today.steps)}           |  Active Cal:  ${fmt(today.calsBurned," kcal")}
Calories:     ${fmt(today.calories," kcal")}|  Protein:     ${fmt(today.protein,"g")}
Carbs:        ${fmt(today.carbs,"g")}       |  Fat:         ${fmt(today.fat,"g")}
Workout Vol:  ${fmt(today.workoutVol," lbs")}| Duration:    ${fmt(today.workoutDur," min")}
VO2 Max:      ${fmt(today.vo2max)}          |  SpO2:        ${fmt(today.spo2,"%")}

━━ 30-DAY AVERAGES ━━
Avg Weight: ${avg("weight")} lbs  |  Avg BF: ${avg("bodyFat")}%  |  Avg HRV: ${avg("hrv")} ms
Avg Sleep: ${avg("sleepDur")}h    |  Avg Steps: ${avg("steps")}  |  Avg Protein: ${avg("protein")}g
Avg Calories: ${avg("calories")} kcal  |  Avg Workout Vol: ${avg("workoutVol")} lbs

━━ TREND (last 7 days weight) ━━
${snapshots.slice(0,7).map(s => `  ${s.syncDate||""}: ${fmt(s.weight," lbs")} | BF: ${fmt(s.bodyFat,"%")} | HRV: ${fmt(s.hrv," ms")}`).join("\n")}
`.trim();
}

function buildEmailHtml(coachingText, today) {
  const bf = today.bodyFat != null ? today.bodyFat.toFixed(1) : "—";
  const w  = today.weight  != null ? today.weight.toFixed(1)  : "—";
  const hrv = today.hrv    != null ? today.hrv.toFixed(0)     : "—";
  const paragraphs = coachingText
    .split(/\n\n+/)
    .map(p => `<p style="margin:0 0 16px;line-height:1.7;color:#e0e0e0">${p.replace(/\n/g,"<br>").replace(/\*\*([^*]+)\*\*/g,"<strong>$1</strong>").replace(/^#{1,3}\s+(.+)$/gm, "<strong style='color:#00ff9d'>$1</strong>")}</p>`)
    .join("");

  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#07070e;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:640px;margin:0 auto;padding:32px 24px">
    <div style="text-align:center;margin-bottom:32px">
      <div style="font-size:28px;font-weight:900;color:#00ff9d;letter-spacing:3px">⬡ BIOTRACK</div>
      <div style="font-size:13px;color:#666;letter-spacing:2px;margin-top:4px">DAILY COACHING BRIEF</div>
    </div>
    <div style="display:flex;gap:12px;margin-bottom:28px;justify-content:center">
      ${[["⚖️","Weight",w+" lbs"],["🔥","Body Fat",bf+"%"],["🧬","HRV",hrv+" ms"]].map(([icon,label,val])=>`
      <div style="flex:1;background:#0f0f1a;border:1px solid #1e1e2e;border-radius:10px;padding:16px;text-align:center;min-width:120px">
        <div style="font-size:22px">${icon}</div>
        <div style="font-size:20px;font-weight:700;color:#f0f0f0;margin:4px 0">${val}</div>
        <div style="font-size:10px;color:#666;letter-spacing:1px">${label.toUpperCase()}</div>
      </div>`).join("")}
    </div>
    <div style="background:#0f0f1a;border:1px solid #1e1e2e;border-radius:12px;padding:24px;margin-bottom:24px">
      ${paragraphs}
    </div>
    <div style="text-align:center;font-size:11px;color:#333;padding-top:16px;border-top:1px solid #1e1e2e">
      BioTrack · Your personal health AI · <a href="https://biotrack-dashboard.vercel.app" style="color:#00ff9d">View Dashboard</a>
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
    cronMidday:   meta.coaching_cron_midday    || process.env.COACHING_CRON_MD   || "0 16 * * *",
    cronEvening:  meta.coaching_cron_evening   || process.env.COACHING_CRON_PM   || "0 21 * * *",
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
      anthropicKeyHint: s.anthropicKey ? s.anthropicKey.slice(0,12)+"..." : null,
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

function buildSessionPrompt(session, dataCtx) {
  const goals = BRANDON_GOALS;
  if (session === "morning") return `${dataCtx}

${goals}

🌅 5AM MORNING BRIEF — set Brandon up to win the day:
1. **Readiness Score** — HRV / sleep / resting HR → Green (train hard), Yellow (moderate), or Red (recover). Be specific with the numbers.
2. **Goal Tracker** — for EACH goal (BF%, steps, protein, sleep, weight pace) tell him: ✅ on track or ⚠️ behind, with the exact number vs target.
3. **Training Plan** — should he train today? Which muscle groups? Intensity level (heavy/moderate/light/rest)? What time is optimal given his HRV?
4. **Nutrition Blueprint** — exact calorie target and protein gram target for today. What to prioritize at breakfast and lunch to hit protein early.
5. **#1 Action Right Now** — the single most impactful thing to do in the next hour to stay on track for 10% BF.

Sharp, specific, data-driven. This is his 5am launchpad.`;

  if (session === "midday") return `${dataCtx}

${goals}

☀️ 12PM MIDDAY CHECK-IN — how is Brandon doing vs his daily goals RIGHT NOW:
1. **Steps Pace Check** — he has ${Math.round(0)} steps so far. At this pace, will he hit 10,000 today? How many does he need in the next hour to stay on pace?
2. **Nutrition Check** — based on yesterday's protein/calorie data, is he typically ahead or behind at midday? What should he eat RIGHT NOW for lunch to stay on target?
3. **Energy & Recovery** — based on HRV and sleep data, how is his energy likely holding up? Any signs of overtraining or under-recovery?
4. **Afternoon Training Window** — if he hasn't trained yet, what's the optimal workout for this afternoon? Give him a specific plan.
5. **Body Comp Momentum** — is today on track to contribute to reaching 10% BF? What is the one thing he can do in the next 4 hours to guarantee today is a win?

This is his midday course correction. Be direct — is he winning or losing today?`;

  return `${dataCtx}

${goals}

🌙 5PM EVENING PERFORMANCE REVIEW — grade today and plan tomorrow:
1. **Daily Scorecard** — grade each goal (A/B/C/D/F): steps vs 10k, protein vs 180g, calories vs target, sleep from last night, training completed. Overall day grade.
2. **Body Comp Impact** — was today a fat-loss day or not? Based on the data, did today move him toward 10% BF or away from it? By how much?
3. **What to Do TONIGHT** — exact recovery actions: sleep time target, evening meal (if any), wind-down protocol to maximize HRV tomorrow.
4. **Tomorrow's Pre-Plan** — based on today's data, exactly what should tomorrow look like? Training Y/N, calorie target, protein target, step target.
5. **Progress Update** — current BF% is ${0}%. Goal is 10%. At this week's pace, he hits 10% in approximately X weeks. What needs to change to get there faster?

Be brutally honest. No participation trophies. If today was bad, say so and tell him exactly how to fix it tomorrow.`;
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

    const systemPrompt = `You are Brandon Bornancin's personal elite performance coach specializing in body recomposition. Brandon is a vegan founder with one mission: get from ~15-16% body fat to 10% while preserving lean mass. You have 30 days of his biometric data. You are direct, specific, and data-driven — not a generic chatbot. Every response references exact numbers from his data. You speak in a tone that is intense, results-focused, and motivating. Under 500 words. Use **bold** for key numbers and action items.`;

    const userPrompt = buildSessionPrompt(session, dataCtx);
    const coaching = await callClaude(userPrompt, systemPrompt, cfg.anthropicKey);
    console.log(`[coaching] Claude ${session} response received`);

    // ntfy push — title + 200-char preview
    if (cfg.ntfyTopic) {
      const preview = coaching.split("\n").filter(l => l.trim()).slice(0, 3).join(" ").slice(0, 200);
      const titles = {
        morning: `🌅 5AM Brief — ${today.syncDate || "Today"}`,
        midday:  `☀️ 12PM Check-In — ${today.syncDate || "Today"}`,
        evening: `🌙 5PM Recap — ${today.syncDate || "Today"}`,
      };
      await sendPushNotification(titles[session] || "BioTrack Coach", preview, cfg.ntfyTopic);
    }

    // Email — full formatted version
    const subjects = {
      morning: `🌅 BioTrack 5AM Brief — ${today.syncDate || new Date().toLocaleDateString()}`,
      midday:  `☀️ BioTrack 12PM Check-In — ${today.syncDate || new Date().toLocaleDateString()}`,
      evening: `🌙 BioTrack 5PM Recap — ${today.syncDate || new Date().toLocaleDateString()}`,
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
      console.log(`  SECRET_KEY: ${SECRET.slice(0,4)}${"*".repeat(Math.max(0, SECRET.length-4))}`);
      console.log(`  CORS: ${ALLOWED.join(", ") || "all"}`);

      // ── 3 daily coaching sessions (all times UTC):
      //    5am  ET = 9am  UTC  → morning brief
      //    12pm ET = 4pm  UTC  → midday check-in
      //    5pm  ET = 9pm  UTC  → evening recap
      const cronAM = process.env.COACHING_CRON_AM || "0 9 * * *";
      const cronMD = process.env.COACHING_CRON_MD || "0 16 * * *";
      const cronPM = process.env.COACHING_CRON_PM || "0 21 * * *";
      cron.schedule(cronAM, () => {
        console.log("[cron] 5am ET — morning brief");
        runDailyCoaching("morning");
      }, { timezone: "UTC" });
      cron.schedule(cronMD, () => {
        console.log("[cron] 12pm ET — midday check-in");
        runDailyCoaching("midday");
      }, { timezone: "UTC" });
      cron.schedule(cronPM, () => {
        console.log("[cron] 5pm ET — evening recap");
        runDailyCoaching("evening");
      }, { timezone: "UTC" });
      console.log(`  🌅 Morning brief:    ${cronAM} UTC (5am ET)`);
      console.log(`  ☀️  Midday check-in: ${cronMD} UTC (12pm ET)`);
      console.log(`  🌙 Evening recap:    ${cronPM} UTC (5pm ET)`);
      console.log();
    });
  })
  .catch(e => {
    console.error("Fatal startup error:", e.message);
    process.exit(1);
  });

module.exports = app;
