// ─────────────────────────────────────────────────────────────────
//  Product usage tracking. Two sinks:
//   1. Our own Postgres (always on): `activity` = one row per user × day × event × platform with a
//      count, plus a `session` event (a new session starts after 30 idle minutes). From it:
//      first seen, last seen, active days, sessions, and how often every feature was used.
//   2. PostHog (only when POSTHOG_KEY is set) for funnels, cohorts and A/B tests.
//  Events say WHAT someone did, never health values: only event names, platform and counts.
//
//    POST /events        { events: [{ name, platform? }] }   client screens/taps (web + iPhone)
//    GET  /admin/usage   owner: summary, DAU/WAU/MAU, features, retention cohorts, per-user table
//    GET  /admin/usage/user/:id   owner: one person's features + daily timeline
// ─────────────────────────────────────────────────────────────────
const KEY = process.env.POSTHOG_KEY || "";
const HOST = (process.env.POSTHOG_HOST || "https://us.i.posthog.com").replace(/\/$/, "");
const OWNER = "owner";
const SESSION_GAP = 30 * 60e3;

// METHOD route → event. Only successful (2xx) requests count.
const ROUTES = {
  "POST /sync": "health_synced",
  "GET /app/board": "dashboard_viewed",
  "GET /history": "dashboard_viewed",
  "GET /app/metrics": "metrics_list_viewed",
  "GET /app/metric": "metric_detail_viewed",
  "GET /app/benchmarks": "benchmarks_viewed",
  "POST /ask": "ai_question_asked",
  "POST /import/file": "file_imported",
  "GET /measurements": "measurements_viewed",
  "POST /measurements/extract": "measurements_read",
  "POST /measurements": "measurements_saved",
  "POST /measurements/:id/delete": "measurements_deleted",
  "POST /automations": "automation_saved",
  "POST /coaching/run": "coaching_run",
  "GET /coaching/latest": "coaching_viewed",
  "GET /reviews": "weekly_review_viewed",
  "POST /reviews/run": "weekly_review_generated",
  "GET /profile": "profile_viewed",
  "POST /profile": "profile_saved",
  "POST /consent": "consent_accepted",
  "POST /feedback": "feedback_sent",
  "GET /export": "data_exported",
  "POST /account/delete": "account_deleted",
  "POST /connect/:p/start": "connector_started",
  "POST /connect/:p/sync": "connector_synced",
  "POST /connect/:p/disconnect": "connector_disconnected",
  "POST /builder/approve/:id": "builder_change_approved",
  "POST /builder/undo/:id": "builder_change_undone",
  "POST /builder/tool/:name": "builder_used",
  "POST /sections": "section_created",
  "POST /sections/from-file": "section_created",
  "POST /sections/from-template": "template_added",
  "POST /sections/:id/run": "section_run",
  "POST /sections/:id/import": "section_imported",
  "POST /agent/report": "agent_report",
  "POST /keys": "api_key_created",
};
// Events that fire several times per real use: count once per window per user.
const THROTTLE = { health_synced: 10 * 60e3, dashboard_viewed: 5 * 60e3, profile_viewed: 5 * 60e3, measurements_viewed: 5 * 60e3, weekly_review_viewed: 5 * 60e3, coaching_viewed: 5 * 60e3 };
// Things that happen without the person using the app (background sync, account events):
// counted as features, but they don't start a session or make a day "active".
const PASSIVE = ["health_synced", "connector_synced", "signed_up", "account_deleted"];
const PASSIVE_SQL = PASSIVE.map(e => `'${e}'`).join(",");
const CLIENT_NAME = /^[a-z][a-z0-9_]{1,47}$/;
const SCREEN_NAME = /^[A-Za-z][A-Za-z0-9 _&-]{0,39}$/;

let pool = null;
let phQueue = [];
const pending = new Map();   // "user|day|event|platform" → { n, first, last }
const lastAt = new Map();    // "user|event" → ms (throttle)
const lastSeen = new Map();  // user → ms (sessions)

const platformOf = (req) => {
  const p = String(req.get("x-platform") || "").toLowerCase();
  if (["web", "ios", "android"].includes(p)) return p;
  const ua = String(req.get("user-agent") || "");
  return /Mozilla/.test(ua) ? "web" : /CFNetwork|Darwin|BodyData/.test(ua) ? "ios" : "server";
};

function bump(user, event, platform, at) {
  const day = new Date(at).toISOString().slice(0, 10);
  const k = `${user}|${day}|${event}|${platform}`;
  const e = pending.get(k);
  if (e) { e.n++; e.last = at; } else pending.set(k, { n: 1, first: at, last: at });
}

/** Record one use. platform: web | ios | server. props go to PostHog only (never the DB). */
function capture(user, event, props = {}, platform = props.platform || "server") {
  if (!user || !event) return;
  const now = Date.now();
  const tw = THROTTLE[event];
  if (tw) { const k = `${user}|${event}`; if (now - (lastAt.get(k) || 0) < tw) return; lastAt.set(k, now); }
  if (platform !== "server" && !PASSIVE.includes(event)) {         // sessions count only people using an app
    if (now - (lastSeen.get(user) || 0) > SESSION_GAP) { bump(user, "session", platform, now); phPush(user, "session_started", { platform }); }
    lastSeen.set(user, now);
  }
  bump(user, event, platform, now);
  phPush(user, event, { ...props, platform });
  if (lastAt.size > 100000) lastAt.clear();
  if (lastSeen.size > 100000) lastSeen.clear();
}

function phPush(user, event, props) {
  if (!KEY) return;
  const properties = { ...props, $lib: "bodydata-api" };
  if (user === OWNER) properties.$set = { internal: true };   // filter the founder out of beta metrics
  phQueue.push({ event, distinct_id: String(user), properties, timestamp: new Date().toISOString() });
}

async function flush() {
  if (pool && pending.size) {
    const rows = [...pending.entries()]; pending.clear();
    const users = new Map();
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500), vals = [], ph = [];
      for (const [k, v] of chunk) {
        const [user, day, event, platform] = k.split("|");
        ph.push(`($${vals.length + 1},$${vals.length + 2},$${vals.length + 3},$${vals.length + 4},$${vals.length + 5},$${vals.length + 6},$${vals.length + 7})`);
        vals.push(user, day, event, platform, v.n, new Date(v.first), new Date(v.last));
        if (!PASSIVE.includes(event)) users.set(user, Math.max(users.get(user) || 0, v.last));
      }
      try {
        await pool.query(`INSERT INTO activity (user_id, day, event, platform, n, first_at, last_at) VALUES ${ph.join(",")}
          ON CONFLICT (user_id, day, event, platform) DO UPDATE SET n = activity.n + EXCLUDED.n, last_at = GREATEST(activity.last_at, EXCLUDED.last_at)`, vals);
      } catch (e) { console.warn("activity: write failed:", e.message); }
    }
    for (const [u, t] of users) pool.query(`UPDATE users SET last_seen = GREATEST(COALESCE(last_seen, 'epoch'), $2) WHERE id = $1`, [u, new Date(t)]).catch(() => {});
  }
  if (KEY && phQueue.length) {
    const batch = phQueue; phQueue = [];
    try {
      const r = await fetch(`${HOST}/batch/`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ api_key: KEY, batch }), signal: AbortSignal.timeout(10000) });
      if (!r.ok) console.warn("analytics: PostHog returned", r.status);
    } catch (e) { console.warn("analytics: send failed:", e.message); }
  }
}

// Express middleware: counts the mapped routes after they succeed.
function middleware(req, res, next) {
  res.on("finish", () => {
    if (res.statusCode >= 300 || !req.userId) return;
    const name = ROUTES[`${req.method} ${req.route?.path || req.path}`];
    if (!name) return;
    const props = {};
    if (name === "file_imported" && req.body?.filename) props.file_type = String(req.body.filename).split(".").pop().toLowerCase().slice(0, 8);
    if (/^connector_/.test(name) && req.params?.p) props.provider = String(req.params.p).slice(0, 20);
    capture(req.userId, name, props, platformOf(req));
  });
  next();
}

// One-time backfill from data we already have, so first-seen and history start at the real beginning.
async function backfill() {
  const done = await pool.query(`SELECT 1 FROM ops_settings WHERE key = 'activity_backfill_v1'`).catch(() => ({ rows: [] }));
  if (done.rows.length) return;
  await pool.query(`
    INSERT INTO activity (user_id, day, event, platform, n, first_at, last_at)
    SELECT user_id, (received_at AT TIME ZONE 'UTC')::date, ev, pf, COUNT(DISTINCT date_trunc('hour', received_at)), MIN(received_at), MAX(received_at)
    FROM (SELECT user_id, received_at,
            CASE WHEN data->>'_source' = 'measurements' THEN 'measurements_saved'
                 WHEN data ? 'hkMeta' OR data->>'_source' IS NULL OR data->>'_source' IN ('ios','healthkit') THEN 'health_synced'
                 WHEN data->>'_source' ILIKE '%connector%' OR data->>'_source' IN ('whoop','oura','withings','fitbit','garmin','strava') THEN 'connector_synced'
                 ELSE 'file_imported' END ev,
            CASE WHEN data ? 'hkMeta' THEN 'ios' ELSE 'server' END pf
          FROM snapshots WHERE user_id IS NOT NULL) s
    GROUP BY 1, 2, 3, 4
    ON CONFLICT (user_id, day, event, platform) DO NOTHING`);
  await pool.query(`
    INSERT INTO activity (user_id, day, event, platform, n, first_at, last_at)
    SELECT user_id, (at AT TIME ZONE 'UTC')::date,
           CASE feature WHEN 'measurements' THEN 'measurements_read' WHEN 'weekly_review' THEN 'weekly_review_generated' WHEN 'coaching' THEN 'coaching_run' ELSE 'ai_question_asked' END,
           'server', COUNT(*), MIN(at), MAX(at)
    FROM ai_usage GROUP BY 1, 2, 3
    ON CONFLICT (user_id, day, event, platform) DO NOTHING`);
  await pool.query(`INSERT INTO ops_settings (key, value) VALUES ('activity_backfill_v1', $1) ON CONFLICT (key) DO NOTHING`, [new Date().toISOString()]);
  console.log("activity: backfilled from snapshots and ai_usage");
}

function install(app, { auth, pool: p }) {
  pool = p;
  const ready = pool.query(`
    CREATE TABLE IF NOT EXISTS activity (
      user_id TEXT NOT NULL, day DATE NOT NULL, event TEXT NOT NULL, platform TEXT NOT NULL DEFAULT 'server',
      n INT NOT NULL DEFAULT 0, first_at TIMESTAMPTZ NOT NULL, last_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (user_id, day, event, platform));
    CREATE INDEX IF NOT EXISTS idx_activity_day ON activity (day);
    CREATE INDEX IF NOT EXISTS idx_activity_event ON activity (event, day);
    CREATE TABLE IF NOT EXISTS ops_settings (key TEXT PRIMARY KEY, value TEXT);`)
    .then(backfill).catch(e => console.error("activity: setup failed:", e.message));
  setInterval(flush, 10000).unref();
  // Save the last few seconds of counts on shutdown, then exit (a SIGTERM listener replaces Node's default exit).
  process.once("SIGTERM", () => { Promise.race([flush(), new Promise(r => setTimeout(r, 3000))]).finally(() => process.exit(0)); });

  // Client events: screens and in-app actions that don't hit an API route.
  app.post("/events", auth, (req, res) => {
    const list = Array.isArray(req.body?.events) ? req.body.events.slice(0, 100) : [];
    const pf = ["web", "ios", "android"].includes(req.body?.platform) ? req.body.platform : platformOf(req);
    let n = 0;
    for (const e of list) {
      const name = String(e?.name || "");
      if (e?.screen && SCREEN_NAME.test(String(e.screen))) { capture(req.userId, `screen:${e.screen}`, {}, pf); n++; }
      else if (CLIENT_NAME.test(name) && !ROUTE_EVENTS.has(name)) { capture(req.userId, name, {}, pf); n++; }
    }
    res.json({ ok: true, accepted: n });
  });

  const ownerOnly = (req, res, next) => req.userId === OWNER ? next() : res.status(403).json({ error: "Owner only." });

  app.get("/admin/usage", auth, ownerOnly, async (req, res) => {
    try {
      await ready; await flush();
      const internal = req.query.internal !== "0";               // include the founder unless ?internal=0
      const who = internal ? "TRUE" : `a.user_id <> '${OWNER}'`;
      const q = (sql, args = []) => pool.query(sql, args).then(r => r.rows);
      const [totals] = await q(`
        SELECT COUNT(DISTINCT user_id) FILTER (WHERE day = CURRENT_DATE) dau,
               COUNT(DISTINCT user_id) FILTER (WHERE day > CURRENT_DATE - 7) wau,
               COUNT(DISTINCT user_id) FILTER (WHERE day > CURRENT_DATE - 30) mau,
               COUNT(DISTINCT user_id) users_ever
        FROM activity a WHERE ${who} AND event NOT IN (${PASSIVE_SQL})`);
      const features = await q(`
        SELECT event, COUNT(DISTINCT user_id)::int users_ever, COUNT(DISTINCT user_id) FILTER (WHERE day > CURRENT_DATE - 30)::int users_30d,
               SUM(n)::int uses, COALESCE(SUM(n) FILTER (WHERE day > CURRENT_DATE - 30), 0)::int uses_30d,
               COALESCE(SUM(n) FILTER (WHERE day > CURRENT_DATE - 7), 0)::int uses_7d,
               COUNT(DISTINCT (user_id, day))::int user_days, MIN(first_at) first_used, MAX(last_at) last_used
        FROM activity a WHERE ${who} GROUP BY event ORDER BY uses_30d DESC, uses DESC`);
      const users = await q(`
        SELECT a.user_id id, u.email, u.created_at signed_up,
               MIN(a.first_at) first_seen,                                                    -- anything, incl. the first Health sync
               MAX(a.last_at) FILTER (WHERE a.event NOT IN (${PASSIVE_SQL})) last_active,     -- last time they actually used it
               MAX(a.last_at) FILTER (WHERE a.event IN ('health_synced','connector_synced')) last_sync,
               COUNT(DISTINCT a.day) FILTER (WHERE a.event NOT IN (${PASSIVE_SQL}))::int active_days,
               COUNT(DISTINCT a.day) FILTER (WHERE a.event NOT IN (${PASSIVE_SQL}) AND a.day > CURRENT_DATE - 7)::int active_days_7d,
               COUNT(DISTINCT a.day) FILTER (WHERE a.event NOT IN (${PASSIVE_SQL}) AND a.day > CURRENT_DATE - 30)::int active_days_30d,
               COALESCE(SUM(a.n) FILTER (WHERE a.event = 'session'), 0)::int sessions,
               COALESCE(SUM(a.n) FILTER (WHERE a.event = 'session' AND a.day > CURRENT_DATE - 30), 0)::int sessions_30d,
               COALESCE(SUM(a.n) FILTER (WHERE a.event NOT IN ('session',${PASSIVE_SQL}) AND a.event NOT LIKE 'screen:%'), 0)::int uses,
               COUNT(DISTINCT a.event) FILTER (WHERE a.event NOT IN ('session',${PASSIVE_SQL}) AND a.event NOT LIKE 'screen:%')::int features_used,
               array_agg(DISTINCT a.platform) FILTER (WHERE a.platform <> 'server') platforms
        FROM activity a LEFT JOIN users u ON u.id = a.user_id
        WHERE ${who} AND a.event <> 'signed_up'
        GROUP BY a.user_id, u.email, u.created_at ORDER BY last_active DESC NULLS LAST LIMIT 1000`);
      // Retention: of people first seen in week W, the share active again in weeks 1, 2, 4 and 8 after.
      const cohorts = await q(`
        WITH f AS (SELECT user_id, MIN(day) d0 FROM activity a WHERE ${who} AND event NOT IN (${PASSIVE_SQL}) GROUP BY user_id),
             act AS (SELECT DISTINCT a.user_id, (a.day - f.d0) / 7 wk FROM activity a JOIN f USING (user_id) WHERE event NOT IN (${PASSIVE_SQL}))
        SELECT to_char(date_trunc('week', f.d0), 'YYYY-MM-DD') cohort, COUNT(DISTINCT f.user_id)::int people,
               COUNT(DISTINCT act.user_id) FILTER (WHERE act.wk = 1)::int w1, COUNT(DISTINCT act.user_id) FILTER (WHERE act.wk = 2)::int w2,
               COUNT(DISTINCT act.user_id) FILTER (WHERE act.wk = 4)::int w4, COUNT(DISTINCT act.user_id) FILTER (WHERE act.wk = 8)::int w8
        FROM f LEFT JOIN act USING (user_id) GROUP BY 1 ORDER BY 1 DESC LIMIT 26`);
      const daily = await q(`
        SELECT to_char(day, 'YYYY-MM-DD') AS day, COUNT(DISTINCT user_id) FILTER (WHERE event NOT IN (${PASSIVE_SQL}))::int active_users, COALESCE(SUM(n) FILTER (WHERE event = 'session'), 0)::int sessions,
               COALESCE(SUM(n) FILTER (WHERE event NOT IN ('session',${PASSIVE_SQL})), 0)::int uses
        FROM activity a WHERE ${who} AND day > CURRENT_DATE - 90 GROUP BY day ORDER BY day`);
      const mau = Number(totals.mau) || 0;
      res.json({ generatedAt: new Date().toISOString(), timezone: "UTC", internalIncluded: internal,
        summary: { ...Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, Number(v)])), stickiness: mau ? Math.round(Number(totals.dau) / mau * 100) / 100 : null },
        features: features.map(f => ({ ...f, adoption_30d: mau ? Math.round(f.users_30d / mau * 100) : null })),
        users, cohorts, daily });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get("/admin/usage/user/:id", auth, ownerOnly, async (req, res) => {
    try {
      await ready; await flush();
      const id = String(req.params.id);
      const features = (await pool.query(`SELECT event, SUM(n)::int uses, COUNT(DISTINCT day)::int days, MIN(first_at) first_used, MAX(last_at) last_used,
          array_agg(DISTINCT platform) platforms FROM activity WHERE user_id = $1 GROUP BY event ORDER BY uses DESC`, [id])).rows;
      const days = (await pool.query(`SELECT to_char(day, 'YYYY-MM-DD') AS day, jsonb_object_agg(event, n) events FROM
          (SELECT day, event, SUM(n)::int n FROM activity WHERE user_id = $1 GROUP BY day, event) x GROUP BY day ORDER BY day DESC LIMIT 400`, [id])).rows;
      res.json({ id, features, days });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  return { capture, flush };
}

const ROUTE_EVENTS = new Set(Object.values(ROUTES));
module.exports = { capture, flush, middleware, install, ROUTES };
