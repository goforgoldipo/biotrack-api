// ─────────────────────────────────────────────────────────────────
//  BIOTRACK API  v2.1
//  Receives health snapshots from iOS app → serves to dashboard
//
//  ENV VARS (set in Railway dashboard → Variables):
//    SECRET_KEY              = <your secret>
//    PORT                    = 3000  (Railway sets automatically)
//    ALLOWED_ORIGIN          = https://biotrack-dashboard.vercel.app
//    UPSTASH_REDIS_REST_URL  = https://xxxxx.upstash.io   ← persistent storage
//    UPSTASH_REDIS_REST_TOKEN= AXxxxxxxx                  ← persistent storage
//
//  Storage priority:
//    1. Upstash Redis (persistent across Railway restarts) — use when env vars set
//    2. Local data.json (falls back when Redis not configured — data lost on restart)
// ─────────────────────────────────────────────────────────────────

const express = require("express");
const cors    = require("cors");
const fs      = require("fs");
const path    = require("path");
const crypto  = require("crypto");

const app    = express();
const PORT   = process.env.PORT   || 3000;
const SECRET = process.env.SECRET_KEY || (() => { throw new Error("SECRET_KEY env var required"); })();
const DATA_FILE = path.join(__dirname, "data.json");

// ── Upstash Redis (optional — persistent storage)
const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const USE_REDIS   = !!(REDIS_URL && REDIS_TOKEN);
const REDIS_KEY   = "biotrack:state";

// ── In-memory state (loaded once at startup)
let STATE = { history: [], latest: null, meta: {} };

async function redisCmd(...args) {
  const r = await fetch(`${REDIS_URL}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify([args]),
  });
  if (!r.ok) throw new Error(`Redis HTTP ${r.status}`);
  const [{ result, error }] = await r.json();
  if (error) throw new Error(`Redis error: ${error}`);
  return result;
}

async function initStorage() {
  if (USE_REDIS) {
    try {
      const result = await redisCmd("GET", REDIS_KEY);
      if (result) {
        STATE = JSON.parse(result);
        console.log(`  ✓ Redis: loaded ${STATE.history?.length || 0} snapshots`);
        return;
      }
      console.log("  Redis: no data yet — starting fresh");
      return;
    } catch (e) {
      console.error(`  ⚠ Redis init error: ${e.message} — falling back to file`);
    }
  }
  // File fallback
  try {
    if (fs.existsSync(DATA_FILE)) {
      STATE = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      console.log(`  File: loaded ${STATE.history?.length || 0} snapshots`);
    }
  } catch (e) { console.error("File load error:", e.message); }
}

// Synchronous load — returns in-memory state
function load() {
  return STATE;
}

// Save to memory + background-flush to Redis or file
function save(state) {
  STATE = state;
  if (USE_REDIS) {
    // Fire-and-forget Redis write (don't block the HTTP response)
    const payload = JSON.stringify(state);
    redisCmd("SET", REDIS_KEY, payload)
      .catch(e => console.error("Redis save error:", e.message));
  } else {
    // File fallback (sync, local dev only)
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(state)); }
    catch (e) { console.error("File save error:", e.message); }
  }
}

// ── CORS — allow dashboard origin + localhost for dev
const ALLOWED = [
  process.env.ALLOWED_ORIGIN,          // e.g. https://biotrack-dashboard.vercel.app
  "http://localhost:5173",             // Vite dev server
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

// POST /sync — iOS app posts here after reading HealthKit
app.post("/sync", auth, (req, res) => {
  const snap = req.body;
  if (!snap || typeof snap !== "object" || Array.isArray(snap)) {
    return res.status(400).json({ error: "Body must be a JSON object" });
  }

  snap._receivedAt  = new Date().toISOString();
  snap._id          = crypto.randomUUID();

  const state = load();
  state.latest = snap;

  state.history.unshift(snap);
  if (state.history.length > 20000) state.history = state.history.slice(0, 20000);

  save(state);

  const count = Object.keys(snap).filter(k => !k.startsWith("_")).length;
  console.log(`[${snap._receivedAt}] ✓ Synced ${snap.syncDate || "?"} ${snap.syncTime || ""} — ${count} fields`);

  res.json({ ok: true, id: snap._id, receivedAt: snap._receivedAt, fieldCount: count });
});

// GET /latest — dashboard polls this every 2 min
app.get("/latest", auth, (req, res) => {
  const { latest } = load();
  if (!latest) return res.status(404).json({ error: "No data yet — open BioTrack Health on iPhone and tap Sync Now" });
  res.json(latest);
});

// GET /history?days=30 — last N days of snapshots
app.get("/history", auth, (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 30, 20000);
  const { history } = load();

  const withDates = history.map(snap => {
    let dateKey = "unknown";
    if (snap.syncDate) {
      const hasYear = /\b\d{4}\b/.test(snap.syncDate);
      const now = new Date();
      let parsed;
      if (hasYear) {
        // "Apr 12 2026" → add comma for reliable parsing
        const normed = snap.syncDate.replace(/^([A-Za-z]+\s+\d{1,2})\s+(\d{4})/, "$1, $2");
        parsed = new Date(normed);
      } else {
        parsed = new Date(snap.syncDate + ", " + now.getFullYear());
        if (!isNaN(parsed.getTime()) && parsed > new Date(now.getTime() + 86400000)) {
          parsed.setFullYear(parsed.getFullYear() - 1);
        }
      }
      if (!isNaN(parsed.getTime())) {
        dateKey = parsed.toISOString().slice(0, 10);
      }
    }
    if (dateKey === "unknown" && snap._receivedAt) {
      dateKey = snap._receivedAt.slice(0, 10);
    }
    return { ...snap, _dateKey: dateKey };
  });

  // Merge all snapshots for the same day
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

  const sorted = Object.values(byDate)
    .sort((a, b) => (b._dateKey || "").localeCompare(a._dateKey || ""))
    .slice(0, days)
    .map(({ _dateKey, ...rest }) => rest);

  res.json({ count: sorted.length, days, snapshots: sorted });
});

// GET /stats — aggregate summary
app.get("/stats", auth, (req, res) => {
  const { history, latest } = load();
  if (!latest) return res.status(404).json({ error: "No data yet" });

  const nums = (key) => history.map(s => s[key]).filter(v => typeof v === "number");
  const avg  = (arr) => arr.length ? +(arr.reduce((a,b) => a+b, 0) / arr.length).toFixed(1) : null;

  res.json({
    latest,
    averages: {
      bodyFat:   avg(nums("bodyFat")),
      weight:    avg(nums("weight")),
      steps:     avg(nums("steps")),
      protein:   avg(nums("protein")),
      calories:  avg(nums("calories")),
      hrv:       avg(nums("hrv")),
      sleepDur:  avg(nums("sleepDuration")),
    },
    totalSnapshots: history.length,
    firstSync: history[history.length - 1]?._receivedAt || null,
    lastSync:  latest._receivedAt,
  });
});

// GET /health — Railway uptime checks (no auth)
app.get("/health", (_req, res) => {
  const { latest, history } = load();
  res.json({
    status: "ok",
    storage: USE_REDIS ? "redis" : "file",
    lastSync: latest?._receivedAt || null,
    totalSnapshots: history.length,
    uptime: Math.round(process.uptime()),
    version: "2.1.0",
  });
});

// GET / — API info
app.get("/", (_req, res) => {
  res.json({
    name: "BioTrack API",
    version: "2.1.0",
    storage: USE_REDIS ? "upstash-redis" : "file (ephemeral — set UPSTASH env vars for persistence)",
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

// GET /meta
app.get("/meta", auth, (req, res) => {
  const state = load();
  res.json(state.meta || {});
});

// POST /meta
app.post("/meta", auth, (req, res) => {
  const updates = req.body;
  if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
    return res.status(400).json({ error: "Body must be a JSON object" });
  }
  const state = load();
  state.meta = { ...(state.meta || {}), ...updates };
  save(state);
  console.log(`[meta] updated:`, Object.keys(updates).join(", "));
  res.json({ ok: true, meta: state.meta });
});

// ── 404
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

// ── Error handler
app.use((err, _req, res, _next) => {
  console.error(err.message);
  res.status(500).json({ error: err.message });
});

// ── Start: load storage first, then listen
initStorage().then(() => {
  app.listen(PORT, () => {
    console.log(`\n⬡ BioTrack API v2.1 — port ${PORT}`);
    console.log(`  Storage: ${USE_REDIS ? `Upstash Redis (${REDIS_URL?.slice(0,40)}...)` : "local file (ephemeral)"}`);
    console.log(`  SECRET_KEY: ${SECRET.slice(0,4)}${"*".repeat(Math.max(0, SECRET.length-4))}`);
    console.log(`  CORS origins: ${ALLOWED.join(", ") || "all"}`);
    console.log(`  Snapshots in memory: ${STATE.history?.length || 0}\n`);
  });
}).catch(e => {
  console.error("Fatal startup error:", e.message);
  process.exit(1);
});

module.exports = app;
