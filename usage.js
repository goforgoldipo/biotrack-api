// ─────────────────────────────────────────────────────────────────
//  AI usage metering: every Claude call is recorded per user with its cost.
//  Free beta: each user gets a monthly AI allowance (AI_BUDGET_USD, default $1) plus a
//  credit balance (users.ai_credits, dollars). Past the allowance, calls draw down credits;
//  with none left, AI features ask the user to add credits (dashboards keep working).
//  Owner unlimited. Wrap clients with usage.client(key, feature).
// ─────────────────────────────────────────────────────────────────
const { currentUser, OWNER, als } = require("./tenancy");

// $ per million tokens (input, output, cache read, 5-min cache write) — shared/models.md, 2026-11
const PRICES = {
  "claude-opus-5-5":   { in: 4,   out: 20,  cr: 0.20, cw: 5 },
  "claude-sonnet-5-5": { in: 2,   out: 10,  cr: 0.10, cw: 2.5 },
  "claude-haiku-5-5":  { in: 0.1, out: 0.5, cr: 0.01, cw: 0.125 },
};
const BUDGET = parseFloat(process.env.AI_BUDGET_USD || "1");   // free AI per user per calendar month (beta)

module.exports = function usage({ pool, AnthropicClient, notify }) {
  let ready = null;
  const migrate = () => (ready ||= pool.query(`
    CREATE TABLE IF NOT EXISTS ai_usage (
      id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT NOW(), feature TEXT, model TEXT,
      input_tokens INT, output_tokens INT, cache_read INT, cache_write INT, cost_usd NUMERIC(10,5));
    CREATE INDEX IF NOT EXISTS idx_usage_user_at ON ai_usage (user_id, at DESC);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_credits NUMERIC(10,4) NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS credits_requested_at TIMESTAMPTZ;`));

  const costOf = (model, u) => {
    const p = PRICES[model] || PRICES["claude-opus-5-5"];
    return ((u.input_tokens || 0) * p.in + (u.output_tokens || 0) * p.out + (u.cache_read_input_tokens || 0) * p.cr + (u.cache_creation_input_tokens || 0) * p.cw) / 1e6;
  };
  async function record(feature, msg) {
    try {
      const u = msg?.usage; if (!u) return;
      const uid = als.getStore()?.userId || OWNER;   // background jobs without a user are BodyData's own cost
      await migrate();
      const cost = costOf(msg.model, u), before = uid === OWNER ? 0 : await monthCost(uid);
      await pool.query(`INSERT INTO ai_usage (user_id, feature, model, input_tokens, output_tokens, cache_read, cache_write, cost_usd) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [uid, feature, msg.model, u.input_tokens || 0, u.output_tokens || 0, u.cache_read_input_tokens || 0, u.cache_creation_input_tokens || 0, cost]);
      // the part of this call beyond the monthly allowance comes out of credits
      const over = uid === OWNER ? 0 : Math.min(cost, Math.max(0, before + cost - BUDGET));
      if (over > 0) await pool.query(`UPDATE users SET ai_credits = GREATEST(0, ai_credits - $2) WHERE id = $1`, [uid, over]);
    } catch (e) { console.error("[usage]", e.message); }
  }
  async function monthCost(uid) {
    await migrate();
    const { rows } = await pool.query(`SELECT COALESCE(SUM(cost_usd),0)::float AS c FROM ai_usage WHERE user_id = $1 AND at >= date_trunc('month', NOW())`, [uid]);
    return rows[0].c;
  }
  async function credits(uid) { await migrate(); const { rows } = await pool.query(`SELECT ai_credits::float c, credits_requested_at r FROM users WHERE id = $1`, [uid]); return { credits: rows[0]?.c || 0, requestedAt: rows[0]?.r || null }; }
  async function status(uid) {
    const used = await monthCost(uid), { credits: c, requestedAt } = await credits(uid);
    return { used, allowance: uid === OWNER ? null : BUDGET, credits: c, available: uid === OWNER ? null : Math.max(0, BUDGET - used) + c, requestedAt };
  }
  // Throws a friendly error when the monthly allowance and credits are used up (owner: no limit)
  async function checkBudget() {
    const uid = currentUser(); if (uid === OWNER) return;
    const s = await status(uid);
    if (s.available <= 0) {
      const e = new Error(`You've used this month's free $${BUDGET} of AI. Add credits to keep using Ask AI. Your dashboards, syncing and imports keep working, and the free AI resets on the 1st.`);
      e.status = 429; e.code = "credits_needed"; throw e;
    }
  }
  // A Claude client whose calls are metered under `feature` (callers run checkBudget() first)
  function client(apiKey, feature) {
    const c = new AnthropicClient({ apiKey });
    const wrap = (ns) => {
      const create = ns.create.bind(ns), stream = ns.stream.bind(ns);
      // keep the SDK's own promise object (stream() calls create(...).withResponse() internally)
      ns.create = (body, opts) => { const p = create(body, opts); if (!body?.stream) p.then(m => record(feature, m), () => {}); return p; };
      ns.stream = (body, opts) => {
        const s = stream(body, opts); s.on("finalMessage", (m) => record(feature, m));
        return s;
      };
    };
    wrap(c.messages); if (c.beta?.messages) wrap(c.beta.messages);
    return c;
  }

  function routes(app, auth) {
    app.get("/usage", auth, async (req, res) => {
      await migrate();
      const { rows } = await pool.query(`SELECT feature, COUNT(*)::int AS calls, SUM(cost_usd)::float AS cost FROM ai_usage WHERE user_id = $1 AND at >= date_trunc('month', NOW()) GROUP BY 1 ORDER BY 3 DESC`, [req.userId]);
      const total = rows.reduce((a, r) => a + r.cost, 0);
      res.json({ month: new Date().toISOString().slice(0, 7), cost: total, budget: req.userId === OWNER ? null : BUDGET, ...(await status(req.userId)), byFeature: rows });
    });
    // Beta: no checkout yet. "Add credits" records the request and tells the owner, who can grant credits.
    app.post("/usage/request-credits", auth, async (req, res) => {
      await migrate();
      const { rows: [u] } = await pool.query(`UPDATE users SET credits_requested_at = NOW() WHERE id = $1 AND (credits_requested_at IS NULL OR credits_requested_at < NOW() - INTERVAL '1 day') RETURNING email`, [req.userId]);
      if (u) await notify?.("BodyData: AI credits requested", `${u.email} ran out of AI this month. ${String(req.body?.note || "").slice(0, 200)}`).catch(() => {});
      res.json({ ok: true, message: "Thanks! Paid credits are coming soon. We've noted your request and will top you up." });
    });
    app.post("/usage/grant", auth, async (req, res) => {
      if (req.userId !== OWNER) return res.status(403).json({ error: "Owner only" });
      await migrate();
      const amount = parseFloat(req.body?.amount); if (!(amount > 0 && amount <= 100)) return res.status(400).json({ error: "amount: 0-100 dollars" });
      const { rowCount } = await pool.query(`UPDATE users SET ai_credits = ai_credits + $2, credits_requested_at = NULL WHERE id = $1 OR email = $1`, [String(req.body?.user || ""), amount]);
      res.json({ ok: !!rowCount, granted: rowCount ? amount : 0 });
    });
    // Owner: cost per user and per feature (unit economics)
    app.get("/usage/all", auth, async (req, res) => {
      if (req.userId !== OWNER) return res.status(403).json({ error: "Owner only" });
      await migrate();
      const days = Math.min(365, parseInt(req.query.days) || 30);
      const { rows: users } = await pool.query(`SELECT a.user_id, u.email, u.ai_credits::float credits, u.credits_requested_at, COUNT(*)::int calls, SUM(a.cost_usd)::float cost FROM ai_usage a LEFT JOIN users u ON u.id = a.user_id WHERE a.at >= NOW() - ($1 || ' days')::interval GROUP BY 1,2,3,4 ORDER BY 6 DESC`, [days]);
      const { rows: features } = await pool.query(`SELECT feature, model, COUNT(*)::int calls, SUM(cost_usd)::float cost, AVG(cost_usd)::float avg_cost, AVG(input_tokens)::int avg_in, AVG(output_tokens)::int avg_out FROM ai_usage WHERE at >= NOW() - ($1 || ' days')::interval GROUP BY 1,2 ORDER BY 4 DESC`, [days]);
      res.json({ days, users, features });
    });
  }
  return { client, record, checkBudget, monthCost, status, routes, migrate, PRICES, BUDGET };
};
