// ─────────────────────────────────────────────────────────────────
//  Background jobs: long AI work (reading a 7-page PDF takes ~60 s) runs outside the
//  request, so phones on cellular and Railway's proxy timeout never cut it off.
//  Stored in Postgres, so a deploy or crash mid-job just retries it (max 2 attempts).
//    const J = require("./jobs")({ pool });  J.handle("from_file", fn);  await J.enqueue("from_file", payload)
//  Clients poll GET /jobs/:id → { status: queued|running|done|failed, result | error }.
// ─────────────────────────────────────────────────────────────────
const crypto = require("crypto");
const { currentUser, runAs } = require("./tenancy");

module.exports = function jobs({ pool, concurrency = 2 }) {
  const handlers = {};
  let ready = null, running = 0, timer = null;
  const migrate = () => (ready ||= pool.query(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
      payload JSONB, result JSONB, error TEXT, label TEXT, attempts INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(), started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ);
    CREATE INDEX IF NOT EXISTS idx_jobs_queue ON jobs (status, created_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs (user_id, created_at DESC);`));

  const handle = (kind, fn) => { handlers[kind] = fn; };

  async function enqueue(kind, payload, label = "") {
    await migrate();
    const id = "j" + crypto.randomBytes(8).toString("hex");
    await pool.query(`INSERT INTO jobs (id, user_id, kind, payload, label) VALUES ($1,$2,$3,$4,$5)`, [id, currentUser(), kind, payload, String(label).slice(0, 120)]);
    setImmediate(tick);
    return id;
  }

  // Claim one queued job (SKIP LOCKED: safe with more than one server instance)
  async function claim() {
    const { rows } = await pool.query(`
      UPDATE jobs SET status = 'running', started_at = NOW(), attempts = attempts + 1
      WHERE id = (SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id, user_id, kind, payload, attempts`);
    return rows[0];
  }
  async function tick() {
    try { await migrate(); } catch { return; }
    while (running < concurrency) {
      const j = await claim().catch(e => { console.error("[jobs] claim", e.message); return null; });
      if (!j) return;
      running++;
      runAs(j.user_id, async () => {
        try {
          const fn = handlers[j.kind]; if (!fn) throw new Error("Unknown job type " + j.kind);
          const result = await fn(j.payload || {});
          await pool.query(`UPDATE jobs SET status='done', result=$2, payload=NULL, finished_at=NOW() WHERE id=$1`, [j.id, result ?? {}]);
        } catch (e) {
          const msg = String(e.message || e).slice(0, 500);
          console.error(`[jobs] ${j.kind} ${j.id}: ${msg}`);
          await pool.query(`UPDATE jobs SET status='failed', error=$2, payload=NULL, finished_at=NOW() WHERE id=$1`, [j.id, msg]).catch(() => {});
        } finally { running--; setImmediate(tick); }
      });
    }
  }
  // Jobs left "running" by a restart go back in the queue once; after that they fail
  async function recover() {
    await migrate();
    await pool.query(`UPDATE jobs SET status = CASE WHEN attempts >= 2 THEN 'failed' ELSE 'queued' END,
      error = CASE WHEN attempts >= 2 THEN 'Interrupted twice — try the upload again.' ELSE error END
      WHERE status = 'running' AND started_at < NOW() - INTERVAL '10 minutes'`);
    await pool.query(`DELETE FROM jobs WHERE created_at < NOW() - INTERVAL '30 days'`);
  }
  function start() {
    recover().then(tick).catch(e => console.error("[jobs] start", e.message));
    timer = setInterval(() => { recover().then(tick).catch(() => {}); }, 60e3); timer.unref?.();
  }

  async function get(id) {
    await migrate();
    const { rows } = await pool.query(`SELECT id, kind, status, result, error, label, created_at, finished_at FROM jobs WHERE id = $1 AND user_id = $2`, [id, currentUser()]);
    return rows[0] || null;
  }
  // Run now and wait up to `waitMs`; past that, hand back the job id (client polls)
  async function runOrQueue(kind, payload, label, waitMs = 0) {
    const id = await enqueue(kind, payload, label);
    const until = Date.now() + waitMs;
    while (Date.now() < until) {
      await new Promise(r => setTimeout(r, 1000));
      const j = await get(id); if (j && (j.status === "done" || j.status === "failed")) return j;
    }
    return { id, status: "queued" };
  }

  function routes(app, auth) {
    app.get("/jobs/:id", auth, async (req, res) => {
      const j = await get(req.params.id); if (!j) return res.status(404).json({ error: "No such job" });
      res.json(j);
    });
    app.get("/jobs", auth, async (req, res) => {
      await migrate();
      const { rows } = await pool.query(`SELECT id, kind, status, label, error, created_at, finished_at FROM jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`, [req.userId]);
      res.json({ jobs: rows });
    });
  }
  return { handle, enqueue, get, runOrQueue, start, routes, migrate };
};
