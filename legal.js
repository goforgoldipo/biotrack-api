// ─────────────────────────────────────────────────────────────────
//  Consent + account deletion.
//  Every user must accept the Terms + Privacy Policy and give explicit consent to BodyData
//  collecting and processing their health data (incl. AI providers) before using the apps.
//  Each acceptance is recorded with the document version, time and platform.
//    GET  /consent            { required, current, accepted }
//    POST /consent            { version, terms: true, health: true, platform }
//    POST /account/delete     { confirm: "DELETE" }  → removes every row this user owns
// ─────────────────────────────────────────────────────────────────
const { OWNER } = require("./tenancy");
const TERMS_VERSION = "2026-11-24";

// Tables that hold user-owned rows, and the column naming the owner
const USER_TABLES = [["snapshots", "user_id"], ["meta", "user_id"], ["user_profiles", "user_id"], ["feedback", "user_id"],
  ["ai_usage", "user_id"], ["jobs", "user_id"], ["changes", "user_id"], ["consents", "user_id"], ["api_keys", "user_id"]];

module.exports = function legal(app, { auth, pool }) {
  let ready = null;
  const migrate = () => (ready ||= pool.query(`
    CREATE TABLE IF NOT EXISTS consents (
      id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL, version TEXT NOT NULL, terms BOOLEAN NOT NULL, health BOOLEAN NOT NULL,
      platform TEXT, ip TEXT, user_agent TEXT, at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE INDEX IF NOT EXISTS idx_consents_user ON consents (user_id, at DESC);`).catch(e => { ready = null; throw e; }));

  async function latest(uid) {
    await migrate();
    const { rows } = await pool.query(`SELECT version, at, platform FROM consents WHERE user_id = $1 AND terms AND health ORDER BY at DESC LIMIT 1`, [uid]);
    return rows[0] || null;
  }

  app.get("/consent", auth, async (req, res) => {
    try { const a = await latest(req.userId); res.json({ current: TERMS_VERSION, accepted: a, required: !a || a.version !== TERMS_VERSION }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post("/consent", auth, async (req, res) => {
    try {
      const b = req.body || {};
      if (b.terms !== true || b.health !== true) return res.status(400).json({ error: "Both boxes need to be ticked to use BodyData." });
      if (b.version !== TERMS_VERSION) return res.status(409).json({ error: "The terms were updated. Please review the latest version.", current: TERMS_VERSION });
      await migrate();
      await pool.query(`INSERT INTO consents (user_id, version, terms, health, platform, ip, user_agent) VALUES ($1,$2,true,true,$3,$4,$5)`,
        [req.userId, TERMS_VERSION, String(b.platform || "").slice(0, 20), String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].slice(0, 60),
         String(req.headers["user-agent"] || "").slice(0, 200)]);
      res.json({ ok: true, version: TERMS_VERSION });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Permanent deletion of everything this user owns. The owner account can't be deleted from the app.
  app.post("/account/delete", auth, async (req, res) => {
    const uid = req.userId;
    if (req.body?.confirm !== "DELETE") return res.status(400).json({ error: 'Type DELETE to confirm.' });
    if (uid === OWNER) return res.status(403).json({ error: "The owner account can't be deleted from the app." });
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const removed = {};
      for (const [t, col] of USER_TABLES) {
        await c.query(`SAVEPOINT s`);
        try { removed[t] = (await c.query(`DELETE FROM ${t} WHERE ${col} = $1`, [uid])).rowCount; await c.query(`RELEASE SAVEPOINT s`); }
        catch (e) { await c.query(`ROLLBACK TO SAVEPOINT s`); if (e.code !== "42P01") throw e; }   // table not created yet: nothing to delete
      }
      removed.users = (await c.query(`DELETE FROM users WHERE id = $1`, [uid])).rowCount;
      await c.query("COMMIT");
      console.log(`[account] deleted ${uid}`, JSON.stringify(removed));
      res.json({ ok: true, removed });
    } catch (e) { await c.query("ROLLBACK").catch(() => {}); res.status(500).json({ error: e.message }); }
    finally { c.release(); }
  });

  return { TERMS_VERSION, latest, migrate };
};
