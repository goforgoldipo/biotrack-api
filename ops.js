// ─────────────────────────────────────────────────────────────────
//  Operations: full-database backups, owner alerts, invite-only sign-up.
//
//  Backups (owner only)
//    GET  /admin/backup              gzipped NDJSON of every table, every user (streamed,
//                                    one consistent read-only snapshot). The laptop job
//                                    scripts/backup.sh saves it daily and keeps 30 days.
//  Alerts (pushed to the owner's ntfy topic, each kind at most once every 6 h)
//    • failed background jobs (uploads / document reads)
//    • connector syncs that fail (Withings / WHOOP)
//    • AI spend across all users above ALERT_AI_DAILY_USD (default $5) today
//    • no iPhone sync from the owner for 48 h (the sync itself is broken)
//    • crashes (uncaught errors)
//  External uptime is checked from GitHub Actions (.github/workflows/uptime.yml).
//
//  Sign-up (owner only)
//    GET  /admin/signup                { mode, invites, waitlist }
//    POST /admin/signup                { mode: "invite" | "open" }
//    POST /admin/invites               { email }       → lets that email create an account
//    POST /admin/invites/remove        { email }
//  In invite mode a new sign-in whose email isn't invited gets 403 { code: "waitlist" }
//  and is added to the waitlist (the owner gets a push). Existing users are never blocked.
// ─────────────────────────────────────────────────────────────────
const zlib = require("zlib");
const cron = require("node-cron");
const { OWNER, runAs } = require("./tenancy");

module.exports = function ops(app, { auth, pool, notify }) {
  let ready = null;
  const migrate = () => (ready ||= pool.query(`
    CREATE TABLE IF NOT EXISTS invites (email TEXT PRIMARY KEY, invited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), used_at TIMESTAMPTZ);
    CREATE TABLE IF NOT EXISTS waitlist (email TEXT PRIMARY KEY, first_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), tries INT NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS ops_settings (key TEXT PRIMARY KEY, value TEXT);
  `).catch(e => { ready = null; throw e; }));
  const ownerOnly = (req, res, next) => req.userId === OWNER ? next() : res.status(403).json({ error: "Owner only." });

  // ── Alerts ────────────────────────────────────────────────────
  const lastSent = new Map();
  async function alert(kind, title, body) {
    const now = Date.now();
    if (now - (lastSent.get(kind) || 0) < 6 * 3600e3) return false;
    lastSent.set(kind, now);
    console.warn(`[alert] ${kind}: ${title} — ${body}`);
    try { await notify(`⚠️ ${title}`, String(body).slice(0, 400)); } catch (e) { console.error("[alert] push failed", e.message); }
    return true;
  }

  const AI_DAILY = () => Number(process.env.ALERT_AI_DAILY_USD || 5);
  async function check() {
    const out = [];
    const q = async (sql, p) => (await pool.query(sql, p).catch(e => (e.code === "42P01" ? { rows: [] } : Promise.reject(e)))).rows;
    const failed = await q(`SELECT kind, COUNT(*)::int n, MAX(error) err FROM jobs WHERE status = 'failed' AND finished_at > NOW() - INTERVAL '1 hour' GROUP BY kind`);
    for (const f of failed) out.push(["jobs:" + f.kind, `${f.n} ${f.kind} job${f.n > 1 ? "s" : ""} failed`, f.err || "See Railway logs."]);
    const [spend] = await q(`SELECT COALESCE(SUM(cost_usd), 0)::float usd, COUNT(DISTINCT user_id)::int users FROM ai_usage WHERE at >= date_trunc('day', NOW())`);
    if (spend && spend.usd > AI_DAILY()) out.push(["ai-spend", `AI spend today $${spend.usd.toFixed(2)}`, `${spend.users} user(s). Alert threshold $${AI_DAILY()} (ALERT_AI_DAILY_USD).`]);
    const [last] = await q(`SELECT MAX(received_at) at FROM snapshots WHERE user_id = $1 AND data ? 'hkMeta'`, [OWNER]);
    if (last?.at && Date.now() - new Date(last.at) > 48 * 3600e3)
      out.push(["owner-sync", "No iPhone sync for 2 days", `Last iPhone upload ${new Date(last.at).toISOString().slice(0, 16).replace("T", " ")} UTC. Open BodyData on the phone; if it still doesn't sync, the sync is broken.`]);
    return out;
  }
  async function runChecks() {
    try { for (const [k, t, b] of await check()) await alert(k, t, b); }
    catch (e) { console.error("[alert] check failed", e.message); }
  }
  cron.schedule("7 * * * *", runChecks, { timezone: "UTC" });

  process.on("uncaughtException", e => { console.error("[crash]", e); alert("crash", "API error", e.stack || e.message); });
  process.on("unhandledRejection", e => { console.error("[unhandled]", e); alert("unhandled", "API error (promise)", e?.stack || String(e)); });

  // ── Backup ────────────────────────────────────────────────────
  app.get("/admin/backup", auth, ownerOnly, async (req, res) => {
    const c = await pool.connect();
    let started = false;
    try {
      await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const { rows: tables } = await c.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`);
      res.setHeader("Content-Type", "application/gzip");
      res.setHeader("Content-Disposition", `attachment; filename="bodydata-${new Date().toISOString().slice(0, 10)}.ndjson.gz"`);
      const gz = zlib.createGzip(); gz.pipe(res); started = true;
      const write = (o) => new Promise(r => gz.write(JSON.stringify(o) + "\n") ? r() : gz.once("drain", r));
      await write({ bodydata_backup: 1, at: new Date().toISOString(), tables: tables.map(t => t.table_name) });
      const counts = {};
      for (const { table_name: t } of tables) {
        const { rows: cols } = await c.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [t]);
        await write({ table: t, columns: cols });
        await c.query(`DECLARE cur NO SCROLL CURSOR FOR SELECT * FROM "${t}"`);
        counts[t] = 0;
        for (;;) {
          const { rows } = await c.query(`FETCH 1000 FROM cur`);
          if (!rows.length) break;
          for (const r of rows) await write({ t, r });
          counts[t] += rows.length;
        }
        await c.query(`CLOSE cur`);
      }
      await write({ end: true, counts });
      await c.query("COMMIT");
      gz.end();
      console.log("[backup] done", JSON.stringify(counts));
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      console.error("[backup] failed", e.message);
      alert("backup", "Backup failed", e.message);
      if (!started) res.status(500).json({ error: e.message }); else res.destroy(e);
    } finally { c.release(); }
  });

  // ── Invite-only sign-up ───────────────────────────────────────
  async function mode() {
    await migrate();
    const { rows } = await pool.query(`SELECT value FROM ops_settings WHERE key = 'signup_mode'`);
    return rows[0]?.value || process.env.SIGNUP_MODE || "invite";
  }
  // Called by tenancy before creating a brand-new account. Returns true to allow.
  async function admit(email) {
    if ((await mode()) === "open") return true;
    email = String(email || "").toLowerCase();
    if (email) {
      const r = await pool.query(`UPDATE invites SET used_at = COALESCE(used_at, NOW()) WHERE email = $1 RETURNING email`, [email]);
      if (r.rows[0]) return true;
      const w = await pool.query(`INSERT INTO waitlist (email) VALUES ($1) ON CONFLICT (email) DO UPDATE SET last_at = NOW(), tries = waitlist.tries + 1 RETURNING tries`, [email]);
      if (w.rows[0]?.tries === 1) notify("New waitlist sign-up", `${email} tried to join BodyData. Invite them in Profile → Beta access.`).catch(() => {});
    }
    return false;
  }

  app.get("/admin/signup", auth, ownerOnly, async (_req, res) => {
    try {
      const m = await mode();
      const inv = await pool.query(`SELECT email, invited_at, used_at FROM invites ORDER BY invited_at DESC LIMIT 500`);
      const wl = await pool.query(`SELECT w.email, w.first_at, w.tries FROM waitlist w WHERE NOT EXISTS (SELECT 1 FROM invites i WHERE i.email = w.email) ORDER BY first_at DESC LIMIT 500`);
      const users = await pool.query(`SELECT COUNT(*)::int n FROM users WHERE id <> $1`, [OWNER]);
      res.json({ mode: m, invites: inv.rows, waitlist: wl.rows, users: users.rows[0].n });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post("/admin/signup", auth, ownerOnly, async (req, res) => {
    const m = req.body?.mode;
    if (!["invite", "open"].includes(m)) return res.status(400).json({ error: 'mode must be "invite" or "open"' });
    await migrate();
    await pool.query(`INSERT INTO ops_settings (key, value) VALUES ('signup_mode', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [m]);
    res.json({ ok: true, mode: m });
  });
  app.post("/admin/invites", auth, ownerOnly, async (req, res) => {
    const emails = [].concat(req.body?.email || req.body?.emails || []).flatMap(s => String(s).split(/[\s,;]+/)).map(s => s.trim().toLowerCase()).filter(s => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
    if (!emails.length) return res.status(400).json({ error: "Enter an email address." });
    await migrate();
    for (const e of emails) await pool.query(`INSERT INTO invites (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`, [e]);
    res.json({ ok: true, invited: emails });
  });
  app.post("/admin/invites/remove", auth, ownerOnly, async (req, res) => {
    await migrate();
    const r = await pool.query(`DELETE FROM invites WHERE email = $1`, [String(req.body?.email || "").toLowerCase()]);
    res.json({ ok: true, removed: r.rowCount });
  });
  app.post("/admin/alerts/test", auth, ownerOnly, async (_req, res) => {
    lastSent.delete("test");
    res.json({ ok: true, sent: await alert("test", "Test alert", "Alerts from the BodyData API reach this phone."), pending: await check() });
  });

  return { alert, admit, mode, check, migrate };
};
