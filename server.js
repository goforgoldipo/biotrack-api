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
// DAILY COACHING ENGINE
// Calls Claude with 30-day biometric data → emails + push notification
//
// ENV VARS needed in Railway Variables tab:
//   ANTHROPIC_API_KEY  = sk-ant-...
//   RESEND_API_KEY     = re_...  (get free at resend.com)
//   COACHING_EMAIL     = your@email.com
//   NTFY_TOPIC         = your-private-topic (e.g. biotrack-brandon-xyz)
// ─────────────────────────────────────────────────────────────────

const cron = require("node-cron");
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

async function sendCoachingEmail(subject, htmlContent, textContent, toEmail, apiKey) {
  if (!apiKey || !toEmail) {
    console.log("  ℹ Email not configured");
    return;
  }
  const resend = new Resend(apiKey);
  await resend.emails.send({
    from: "BioTrack Coach <coach@biotrack.health>",
    to: toEmail,
    subject,
    html: htmlContent,
    text: textContent,
  });
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

async function getCoachingSettings() {
  // DB settings override env vars — set via dashboard UI
  const meta = await dbGetMeta();
  return {
    anthropicKey: meta.coaching_anthropic_key || process.env.ANTHROPIC_API_KEY || null,
    email:        meta.coaching_email         || process.env.COACHING_EMAIL     || null,
    resendKey:    meta.coaching_resend_key    || process.env.RESEND_API_KEY     || null,
    ntfyTopic:    meta.coaching_ntfy_topic    || process.env.NTFY_TOPIC         || null,
    enabled:      meta.coaching_enabled !== "false",
    cronTime:     meta.coaching_cron_time     || process.env.COACHING_CRON      || "0 11 * * *",
  };
}

// POST /coaching/settings — save from dashboard UI (auth required)
app.post("/coaching/settings", auth, async (req, res) => {
  try {
    const { anthropicKey, email, resendKey, ntfyTopic, enabled, cronTime } = req.body;
    const updates = {};
    if (anthropicKey  !== undefined) updates.coaching_anthropic_key = anthropicKey;
    if (email         !== undefined) updates.coaching_email         = email;
    if (resendKey     !== undefined) updates.coaching_resend_key    = resendKey;
    if (ntfyTopic     !== undefined) updates.coaching_ntfy_topic    = ntfyTopic;
    if (enabled       !== undefined) updates.coaching_enabled       = String(enabled);
    if (cronTime      !== undefined) updates.coaching_cron_time     = cronTime;
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
      email:     s.email     || null,
      resendKeySet: !!s.resendKey,
      ntfyTopic: s.ntfyTopic || null,
      enabled:   s.enabled,
      cronTime:  s.cronTime,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

async function runDailyCoaching() {
  const cfg = await getCoachingSettings();
  const ANTHROPIC_KEY = cfg.anthropicKey;
  const TO_EMAIL      = cfg.email;
  if (!ANTHROPIC_KEY) {
    console.log("[coaching] Skipping — Anthropic API key not configured");
    return;
  }
  if (!cfg.enabled) {
    console.log("[coaching] Skipping — coaching disabled");
    return;
  }

  console.log(`[coaching] Running daily coaching brief...`);
  try {
    const raw = await dbGetHistory(30);
    const snapshots = dedupHistory(raw, 30);
    if (!snapshots.length) { console.log("[coaching] No data"); return; }

    const today = snapshots[0];
    const dataCtx = buildDataContext(snapshots);
    const systemPrompt = `You are an elite performance coach and body recomposition specialist. Your athlete is Brandon Bornancin — a vegan founder pushing hard to reach 10% body fat from his current level. You are direct, data-driven, and motivating. You write like a world-class coach who deeply understands the data, not a generic chatbot. Be specific with numbers from the data. Keep responses under 500 words. Use markdown headers and bold for key points.`;
    const userPrompt = `${dataCtx}

Based on this data, give Brandon today's coaching brief covering:
1. **Recovery & Readiness** — what does the HRV/sleep/resting HR tell you about today's readiness?
2. **Body Composition Progress** — weight/BF trend, is he on track for 10%? How many weeks away?
3. **Today's #1 Priority** — the single most important thing to focus on today (training, nutrition, or recovery)
4. **Nutrition Target** — exact calorie and protein targets for today based on his data
5. **Motivation** — one sharp, data-backed sentence to drive him forward

Be brutally honest and specific. No fluff.`;

    const coaching = await callClaude(userPrompt, systemPrompt, ANTHROPIC_KEY);
    console.log("[coaching] Claude response received");

    // Send push notification (short version)
    const lines = coaching.split("\n").filter(l => l.trim()).slice(0,3).join(" ").slice(0,200);
    if (cfg.ntfyTopic) {
      await sendPushNotification(
        `🏋️ BioTrack Daily Brief — ${today.syncDate || "Today"}`,
        lines,
        cfg.ntfyTopic
      );
    }

    // Send email (full version)
    if (TO_EMAIL && cfg.resendKey) {
      const html = buildEmailHtml(coaching, today);
      await sendCoachingEmail(
        `⬡ BioTrack Daily Coach — ${today.syncDate || new Date().toLocaleDateString()}`,
        html,
        coaching,
        TO_EMAIL,
        cfg.resendKey
      );
      console.log(`[coaching] Email sent to ${TO_EMAIL}`);
    }

    // Store in DB so dashboard can show it
    await dbSetMeta({
      last_coaching_brief: coaching,
      last_coaching_date: new Date().toISOString(),
    });

    console.log("[coaching] ✓ Daily coaching complete");
  } catch(e) {
    console.error("[coaching] Error:", e.message);
  }
}

// POST /coaching/run — manually trigger (auth required)
app.post("/coaching/run", auth, async (req, res) => {
  try {
    await runDailyCoaching();
    const meta = await dbGetMeta();
    res.json({ ok: true, brief: meta.last_coaching_brief, date: meta.last_coaching_date });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /coaching/latest — get last brief (auth required)
app.get("/coaching/latest", auth, async (req, res) => {
  try {
    const meta = await dbGetMeta();
    res.json({ brief: meta.last_coaching_brief || null, date: meta.last_coaching_date || null });
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

      // ── Daily coaching cron — checks DB settings each fire so changes take effect immediately
      const cronSchedule = process.env.COACHING_CRON || "0 11 * * *"; // default 11am UTC = 7am ET
      cron.schedule(cronSchedule, () => {
        console.log(`[cron] Firing daily coaching brief...`);
        runDailyCoaching();
      }, { timezone: "UTC" });
      console.log(`  🧠 Daily coaching cron: ${cronSchedule} UTC (configure in dashboard → Sync → Coaching)`);
      console.log();
    });
  })
  .catch(e => {
    console.error("Fatal startup error:", e.message);
    process.exit(1);
  });

module.exports = app;
