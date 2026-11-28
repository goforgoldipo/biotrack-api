// ─────────────────────────────────────────────────────────────────
//  Server-side product events → PostHog. The source of truth for activation and retention:
//  ad blockers can't drop them and every platform (web, iPhone, connectors) is counted the same.
//  Events say WHAT someone did, never health values: only route-level names, platform and counts.
//  Off unless POSTHOG_KEY is set (the project's public "phc_" key). Batched, never blocks a request.
// ─────────────────────────────────────────────────────────────────
const KEY = process.env.POSTHOG_KEY || "";
const HOST = (process.env.POSTHOG_HOST || "https://us.i.posthog.com").replace(/\/$/, "");
const OWNER = "owner";
let queue = [];

// METHOD path (Express route) → event name. Only successful (2xx) requests are counted.
const ROUTES = {
  "POST /sync": "health_synced",
  "GET /app/board": "dashboard_viewed",
  "GET /history": "dashboard_viewed",
  "POST /ask": "ai_question_asked",
  "POST /import/file": "file_imported",
  "POST /measurements/extract": "measurements_read",
  "POST /measurements": "measurements_saved",
  "POST /automations": "automation_saved",
  "POST /coaching/run": "weekly_review_generated",
  "GET /coaching/latest": "weekly_review_viewed",
  "POST /profile": "profile_saved",
  "POST /consent": "consent_accepted",
  "POST /feedback": "feedback_sent",
  "GET /export": "data_exported",
};

const THROTTLE = { health_synced: 10 * 60e3, dashboard_viewed: 30 * 60e3 };
const last = new Map();

const platformOf = (req) => {
  const p = String(req.get("x-platform") || "").toLowerCase();
  if (p) return p;
  const ua = String(req.get("user-agent") || "");
  return /Mozilla/.test(ua) ? "web" : /CFNetwork|Darwin|BodyData/.test(ua) ? "ios" : "server";
};

function capture(distinctId, event, props = {}) {
  if (!KEY || !distinctId) return;
  const properties = { ...props, $lib: "bodydata-api" };
  if (distinctId === OWNER) properties.$set = { internal: true };   // filter the founder out of beta metrics
  queue.push({ event, distinct_id: String(distinctId), properties, timestamp: new Date().toISOString() });
  if (queue.length >= 50) flush();
}

async function flush() {
  if (!KEY || !queue.length) return;
  const batch = queue; queue = [];
  try {
    const r = await fetch(`${HOST}/batch/`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ api_key: KEY, batch }), signal: AbortSignal.timeout(10000) });
    if (!r.ok) console.warn("analytics: PostHog returned", r.status);
  } catch (e) { console.warn("analytics: send failed:", e.message); }
}
if (KEY) { setInterval(flush, 10000).unref(); process.on("beforeExit", flush); }

// Express middleware: counts the mapped routes after they succeed.
function middleware(req, res, next) {
  if (!KEY) return next();
  res.on("finish", () => {
    if (res.statusCode >= 300 || !req.userId) return;
    const name = ROUTES[`${req.method} ${req.route?.path || req.path}`];
    if (!name) return;
    // A sync posts one request per day and a dashboard makes several calls: count these once per window
    const win = THROTTLE[name];
    if (win) { const k = `${req.userId}|${name}`, t = Date.now(); if (t - (last.get(k) || 0) < win) return; last.set(k, t); if (last.size > 50000) last.clear(); }
    const props = { platform: platformOf(req) };
    if (name === "file_imported" && req.body?.filename) props.file_type = String(req.body.filename).split(".").pop().toLowerCase().slice(0, 8);
    capture(req.userId, name, props);
  });
  next();
}

module.exports = { capture, flush, middleware, ROUTES, enabled: () => !!KEY };
