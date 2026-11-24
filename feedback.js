// ─────────────────────────────────────────────────────────────────
//  FEEDBACK — feature requests and bug reports from the iPhone and web apps.
//  Stored per user (feedback table) with app version, device and screen; optional screenshot.
// ─────────────────────────────────────────────────────────────────
const crypto = require("crypto");

const { OWNER } = require("./tenancy");
// bug: how much it gets in the way; feature: how much the user wants it
const PRIORITY = { bug: ["blocking", "annoying", "minor"], feature: ["must_have", "nice_to_have", "idea"] };
module.exports = function registerFeedback(app, { auth, pool, userId, notify }) {
  const ready = pool.query(`CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT,
      platform TEXT, app_version TEXT, device TEXT, screen TEXT, screenshot TEXT,
      status TEXT NOT NULL DEFAULT 'new', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback (created_at DESC);
    ALTER TABLE feedback ADD COLUMN IF NOT EXISTS priority TEXT;`).catch(e => console.error("feedback table:", e.message));

  app.post("/feedback", auth, async (req, res) => {
    try {
      await ready;
      const b = req.body || {};
      const kind = b.kind === "bug" ? "bug" : "feature";
      const title = String(b.title || "").trim().slice(0, 140);
      if (!title) return res.status(400).json({ error: "Add a short title." });
      let shot = null;
      if (typeof b.screenshot === "string" && /^[A-Za-z0-9+/=]+$/.test(b.screenshot.slice(0, 200))) {
        if (b.screenshot.length > 7_000_000) return res.status(400).json({ error: "Screenshot is too large (max ~5 MB)." });
        shot = b.screenshot;
      }
      const priority = (PRIORITY[kind].includes(b.priority) ? b.priority : null);
      const id = "fb_" + crypto.randomBytes(6).toString("hex");
      await pool.query(`INSERT INTO feedback (id, user_id, kind, title, body, platform, app_version, device, screen, screenshot, priority)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, userId(req), kind, title, String(b.body || "").slice(0, 5000), String(b.platform || "").slice(0, 20),
         String(b.appVersion || "").slice(0, 20), String(b.device || "").slice(0, 80), String(b.screen || "").slice(0, 60), shot, priority]);
      console.log(`[feedback] ${kind}${priority ? ` (${priority})` : ""}: ${title}`);
      const { rows: [u] } = await pool.query(`SELECT email FROM users WHERE id = $1`, [userId(req)]).catch(() => ({ rows: [] }));
      notify?.(`${kind === "bug" ? "🐞 Bug" : "💡 Feature request"}${priority ? ` [${priority}]` : ""}: ${title}`,
        `${u?.email || userId(req)}\n${b.body || ""}\n\n${b.platform || ""} ${b.appVersion || ""} · ${b.device || ""} · ${b.screen || ""}`).catch(() => {});
      res.json({ ok: true, id });
    } catch (e) { console.error("/feedback", e); res.status(500).json({ error: e.message }); }
  });

  // Your own submissions (and, for the owner, everyone's) — newest first, without screenshots
  app.get("/feedback", auth, async (req, res) => {
    try {
      await ready;
      const { rows } = await pool.query(`SELECT id, kind, title, body, priority, platform, app_version, device, screen, status, created_at, (screenshot IS NOT NULL) AS has_screenshot
        FROM feedback WHERE $1 = '${OWNER}' OR user_id = $1 ORDER BY created_at DESC LIMIT 200`, [userId(req)]);
      res.json({ items: rows, isOwner: userId(req) === OWNER });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post("/feedback/:id/status", auth, async (req, res) => {
    try {
      const s = ["new", "planned", "in_progress", "done", "wont_do"].includes(req.body?.status) ? req.body.status : "new";
      if (userId(req) !== OWNER) return res.status(403).json({ error: "Only the BodyData team can change status." });
      await pool.query(`UPDATE feedback SET status = $1 WHERE id = $2`, [s, req.params.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get("/feedback/:id/screenshot", auth, async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT screenshot FROM feedback WHERE id = $1 AND ($2 = '${OWNER}' OR user_id = $2)`, [req.params.id, userId(req)]);
      if (!rows[0]?.screenshot) return res.status(404).end();
      res.setHeader("Content-Type", "image/jpeg"); res.end(Buffer.from(rows[0].screenshot, "base64"));
    } catch (e) { res.status(500).end(); }
  });
};
