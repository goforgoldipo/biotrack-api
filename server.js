// ─────────────────────────────────────────────────────────────────
//  BIOTRACK API  v2.0
//  Receives health snapshots from iOS app → serves to dashboard
//
//  ENV VARS (set in Railway dashboard → Variables):
//    SECRET_KEY   =  8da2e9f068632f6b113688c222e09d5fae01c15121ea7afafe3d6931a884ba2a
//    PORT         =  3000                       (Railway sets automatically)
//    ALLOWED_ORIGIN = https://biotrack-xxxx.vercel.app  (your Vercel URL)
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

// ── CORS — allow dashboard origin + localhost for dev
const ALLOWED = [
  process.env.ALLOWED_ORIGIN,          // e.g. https://biotrack.vercel.app
  "http://localhost:5173",             // Vite dev server
  "http://localhost:3000",
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // allow requests with no origin (iOS app, curl)
    if (!origin) return cb(null, true);
    if (ALLOWED.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-api-secret"],
}));
app.use(express.json({ limit: "2mb" }));

// ── Auth
function auth(req, res, next) {
  const key = req.headers["x-api-secret"];
  if (!key || key !== SECRET) {
    return res.status(401).json({ error: "Unauthorized — wrong or missing x-api-secret header" });
  }
  next();
}

// ── Storage helpers
function load() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (e) { console.error("Load error:", e.message); }
  return { history: [], latest: null };
}

function save(state) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(state)); }
  catch (e) { console.error("Save error:", e.message); }
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

  // Enrich with server metadata
  snap._receivedAt  = new Date().toISOString();
  snap._id          = crypto.randomUUID();

  const state = load();
  state.latest = snap;

  // Cap history at 90 snapshots (not 90 unique days — keeps every sync)
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

  // Parse each snapshot's actual date from _receivedAt or syncDate
  const withDates = history.map(snap => {
    let dateKey;
    if (snap._receivedAt) {
      dateKey = snap._receivedAt.slice(0, 10); // "2026-04-12"
    } else if (snap.syncDate) {
      // Parse "Apr 12" — assume current year, adjust if in future
      const parsed = new Date(snap.syncDate + ", " + new Date().getFullYear());
      if (parsed > new Date()) parsed.setFullYear(parsed.getFullYear() - 1);
      dateKey = parsed.toISOString().slice(0, 10);
    } else {
      dateKey = "unknown";
    }
    return { ...snap, _dateKey: dateKey };
  });

  // Deduplicate by date — keep newest per day
  const byDate = {};
  for (const snap of withDates) {
    const key = snap._dateKey;
    if (!byDate[key] || snap._receivedAt > byDate[key]._receivedAt) {
      byDate[key] = snap;
    }
  }

  // Sort by date descending (newest first) and limit
  const sorted = Object.values(byDate)
    .sort((a, b) => (b._dateKey || "").localeCompare(a._dateKey || ""))
    .slice(0, days)
    .map(({ _dateKey, ...rest }) => rest); // remove internal field

  res.json({ count: sorted.length, days, snapshots: sorted });
});

// GET /stats — aggregate summary for dashboard
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
    lastSync: latest?._receivedAt || null,
    totalSnapshots: history.length,
    uptime: Math.round(process.uptime()),
    version: "2.0.0",
  });
});

// GET / — API info (no auth)
app.get("/", (_req, res) => {
  res.json({
    name: "BioTrack API",
    version: "2.0.0",
    routes: {
      "POST /sync":    "iOS app → post HealthKit snapshot [auth]",
      "GET  /latest":  "Dashboard → get latest snapshot [auth]",
      "GET  /history": "Dashboard → get last N days [auth] ?days=30",
      "GET  /stats":   "Dashboard → aggregated averages [auth]",
      "GET  /health":  "Uptime check [public]",
    },
  });
});

// ── 404 catch-all
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

// ── Error handler
app.use((err, _req, res, _next) => {
  console.error(err.message);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`\n⬡ BioTrack API v2.0 — port ${PORT}`);
  console.log(`  SECRET_KEY: ${SECRET.slice(0,4)}${"*".repeat(Math.max(0, SECRET.length-4))}`);
  console.log(`  CORS origins: ${ALLOWED.join(", ") || "all"}\n`);
});

module.exports = app;
