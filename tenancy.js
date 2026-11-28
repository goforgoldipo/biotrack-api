// ─────────────────────────────────────────────────────────────────
//  Accounts: who is this request for?
//  Every request runs inside a context holding its user id; every DB helper reads it.
//  Code that touches user data with no context throws instead of falling back to
//  someone's account, so a forgotten scope can't leak data between users.
//
//  Ways in:
//    Authorization: Bearer <Clerk session JWT>   web + iPhone once sign-in ships
//    x-api-secret: <per-user key>                  BodyData Agent, scripts, iPhone sync
//    x-api-secret: <SECRET env>                    the owner (Brandon) — kept working throughout
// ─────────────────────────────────────────────────────────────────
const { AsyncLocalStorage } = require("async_hooks");
const crypto = require("crypto");

const OWNER = "owner";
const als = new AsyncLocalStorage();

function currentUser() {
  const s = als.getStore();
  if (!s?.userId) throw new Error("No user in context (internal: wrap this in runAs)");
  return s.userId;
}
const runAs = (userId, fn) => als.run({ userId }, fn);
const hashKey = (k) => crypto.createHash("sha256").update(String(k)).digest("hex");

module.exports = function tenancy({ pool, SECRET }) {
  let ready = null;
  const migrate = () => (ready ||= pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, username TEXT UNIQUE, display_name TEXT,
      avatar_url TEXT, is_public BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ DEFAULT NOW());
    ALTER TABLE users ADD COLUMN IF NOT EXISTS clerk_id TEXT UNIQUE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'trial';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ;
    INSERT INTO users (id, email, plan) VALUES ('${OWNER}', 'owner@bodydata.local', 'owner') ON CONFLICT (id) DO NOTHING;

    -- every snapshot belongs to a user (existing rows are the owner's)
    ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS user_id TEXT;
    UPDATE snapshots SET user_id = '${OWNER}' WHERE user_id IS NULL OR user_id = 'legacy_brandon';
    CREATE INDEX IF NOT EXISTS idx_snap_user ON snapshots (user_id, received_at DESC);
    CREATE INDEX IF NOT EXISTS idx_snap_user_date ON snapshots (user_id, sync_date);

    -- settings/state per user: primary key (user_id, key)
    ALTER TABLE meta ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT '${OWNER}';
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.key_column_usage WHERE table_name = 'meta' AND constraint_name = 'meta_pkey' AND column_name = 'user_id') THEN
        ALTER TABLE meta DROP CONSTRAINT IF EXISTS meta_pkey;
        ALTER TABLE meta ADD PRIMARY KEY (user_id, key);
      END IF;
    END $$;

    -- per-user API keys (stored hashed; shown once)
    CREATE TABLE IF NOT EXISTS api_keys (
      key_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, label TEXT, prefix TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(), last_used TIMESTAMPTZ);
    CREATE INDEX IF NOT EXISTS idx_keys_user ON api_keys (user_id);
  `).then(() => console.log("  ✓ accounts ready")));

  // ── Clerk session tokens (RS256, JWKS cached 1h). CLERK_DOMAIN = the instance's Frontend API host.
  let admission = null;   // ops.admit(email): may a brand-new account be created? (invite-only beta)
  let jwks = { at: 0, keys: [] };
  async function clerkKeys() {
    if (Date.now() - jwks.at < 3600e3 && jwks.keys.length) return jwks.keys;
    const r = await fetch(`https://${process.env.CLERK_DOMAIN}/.well-known/jwks.json`);
    jwks = { at: Date.now(), keys: (await r.json()).keys || [] }; return jwks.keys;
  }
  async function verifyClerk(token) {
    if (!token || !process.env.CLERK_DOMAIN) return null;
    try {
      const [h, p, sig] = token.split(".");
      const header = JSON.parse(Buffer.from(h, "base64url").toString());
      if (header.alg !== "RS256") return null;
      let jwk = (await clerkKeys()).find(k => k.kid === header.kid);
      if (!jwk) { jwks.at = 0; jwk = (await clerkKeys()).find(k => k.kid === header.kid); }
      if (!jwk) return null;
      const ok = crypto.createVerify("RSA-SHA256").update(`${h}.${p}`).verify(crypto.createPublicKey({ key: jwk, format: "jwk" }), sig, "base64url");
      if (!ok) return null;
      const c = JSON.parse(Buffer.from(p, "base64url").toString()), now = Math.floor(Date.now() / 1000);
      if (c.exp && c.exp < now - 5) return null;
      if (c.nbf && c.nbf > now + 5) return null;
      if (c.iss && c.iss !== `https://${process.env.CLERK_DOMAIN}`) return null;
      const parties = String(process.env.CLERK_AUTHORIZED_PARTIES || "").split(",").map(s => s.trim()).filter(Boolean);
      if (parties.length && c.azp && !parties.includes(c.azp)) return null;
      return c;
    } catch { return null; }
  }
  // Clerk user → BodyData user (created on first sign-in). The owner's Clerk login is linked
  // to the existing "owner" account when its email matches OWNER_EMAIL.
  async function userForClerk(c) {
    await migrate();
    const { rows } = await pool.query(`SELECT id FROM users WHERE clerk_id = $1`, [c.sub]);
    if (rows[0]) return rows[0].id;
    const email = String(c.email || c.primary_email || "").toLowerCase();
    if (email && process.env.OWNER_EMAIL && email === process.env.OWNER_EMAIL.toLowerCase()) {
      const r = await pool.query(`UPDATE users SET clerk_id = $1 WHERE id = '${OWNER}' AND clerk_id IS NULL RETURNING id`, [c.sub]);
      if (r.rows[0]) return OWNER;
    }
    if (admission && !(await admission(email))) { const e = new Error("BodyData is invite-only during the beta. You're on the waitlist and we'll email you when there's a spot."); e.code = "waitlist"; throw e; }
    const ins = await pool.query(`INSERT INTO users (id, email, clerk_id) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING`, [c.sub, email || `${c.sub}@users.bodydata.ai`]);
    if (ins.rowCount) require("./events").capture(c.sub, "signed_up", { $set_once: { signed_up_at: new Date().toISOString() } });
    return c.sub;
  }
  async function userForKey(key) {
    if (!key) return null;
    if (SECRET && key.length === SECRET.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(SECRET))) return OWNER;
    await migrate();
    const { rows } = await pool.query(`UPDATE api_keys SET last_used = NOW() WHERE key_hash = $1 RETURNING user_id`, [hashKey(key)]);
    return rows[0]?.user_id || null;
  }

  async function auth(req, res, next) {
    try {
      const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      let uid = null;
      if (bearer) { const c = await verifyClerk(bearer); if (c) uid = await userForClerk(c); }
      if (!uid) uid = await userForKey(req.headers["x-api-secret"]);
      if (!uid) return res.status(401).json({ error: "Sign in again (session expired or key not recognised)." });
      req.userId = uid;
      pool.query(`UPDATE users SET last_seen = NOW() WHERE id = $1 AND (last_seen IS NULL OR last_seen < NOW() - INTERVAL '10 minutes')`, [uid]).catch(() => {});
      runAs(uid, next);
    } catch (e) {
      if (e.code === "waitlist") return res.status(403).json({ error: e.message, code: "waitlist" });
      res.status(500).json({ error: e.message });
    }
  }

  // Every user that has data or settings — for scheduled jobs
  async function allUsers() { await migrate(); const { rows } = await pool.query(`SELECT id FROM users ORDER BY created_at`); return rows.map(r => r.id); }

  function routes(app) {
    app.get("/me", auth, async (req, res) => {
      const { rows } = await pool.query(`SELECT id, email, display_name, plan, created_at FROM users WHERE id = $1`, [req.userId]);
      res.json({ user: { ...rows[0], owner: req.userId === OWNER, email: rows[0]?.email?.endsWith("bodydata.local") ? null : rows[0]?.email } });
    });
    // API keys for the BodyData Agent / scripts (the key is shown once)
    app.get("/keys", auth, async (req, res) => {
      const { rows } = await pool.query(`SELECT prefix, label, created_at, last_used FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC`, [req.userId]);
      res.json({ keys: rows });
    });
    app.post("/keys", auth, async (req, res) => {
      const key = "bd_" + crypto.randomBytes(24).toString("base64url");
      await pool.query(`INSERT INTO api_keys (key_hash, user_id, label, prefix) VALUES ($1, $2, $3, $4)`, [hashKey(key), req.userId, String(req.body?.label || "BodyData Agent").slice(0, 60), key.slice(0, 7)]);
      res.json({ ok: true, key, note: "Copy it now: it won't be shown again." });
    });
    app.post("/keys/:prefix/revoke", auth, async (req, res) => {
      const r = await pool.query(`DELETE FROM api_keys WHERE user_id = $1 AND prefix = $2`, [req.userId, req.params.prefix]);
      res.json({ ok: true, removed: r.rowCount });
    });
  }

  return { migrate, auth, routes, allUsers, verifyClerk, setAdmission: (fn) => { admission = fn; } };
};
Object.assign(module.exports, { OWNER, currentUser, runAs, als });
