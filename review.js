// ─────────────────────────────────────────────────────────────────
//  Weekly review (coach): every Sunday evening the agent looks at the week that ended,
//  compares it with the 4 weeks before, checks goals and alerts, and writes a short review:
//  what improved, what to watch, and 3 concrete actions for next week. Stored per user,
//  shown in the apps, announced by push. Uses the same data tool as Ask AI (real numbers only).
//    GET /reviews          latest reviews     POST /reviews/run   write one now
// ─────────────────────────────────────────────────────────────────
const cron = require("node-cron");
const { currentUser, runAs, OWNER } = require("./tenancy");

module.exports = function review(app, d) {
  const { auth, dbGetMeta, dbSetMeta, loadDays, catalog, systemPrompt, queryMetrics, dataTool, extraPrompt, getKey, Usage, model, notify } = d;
  const list = (m) => (Array.isArray(m.weekly_reviews) ? m.weekly_reviews : []);

  // Mon–Sun week that ended most recently (in the user's time zone)
  function lastWeek(now = new Date()) {
    const tz = process.env.USER_TZ || "America/New_York";
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    const t = new Date(today + "T12:00:00Z"), dow = (t.getUTCDay() + 6) % 7;   // Mon = 0
    const end = new Date(t.getTime() - (dow === 6 && now.getUTCHours() >= 21 ? 0 : dow + 1) * 864e5);   // Sunday evening: this week
    const start = new Date(end.getTime() - 6 * 864e5);
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
  }

  // Every metric with data this week: this week's daily average vs the 4 weeks before (computed here, not by the AI)
  function weekTable(days, cat, wk) {
    const p0 = new Date(new Date(wk.start).getTime() - 28 * 864e5).toISOString().slice(0, 10);
    const cur = days.filter(x => x._dateKey >= wk.start && x._dateKey <= wk.end), base = days.filter(x => x._dateKey >= p0 && x._dateKey < wk.start);
    const stat = (rows, k) => { const v = rows.map(r => r[k]).filter(x => typeof x === "number" && isFinite(x)); return v.length ? { avg: v.reduce((a, b) => a + b, 0) / v.length, n: v.length } : null; };
    const r2 = (x) => Math.abs(x) >= 100 ? Math.round(x) : Math.round(x * 10) / 10;
    const lines = [], stale = [];
    for (const k of Object.keys(cat).sort()) {
      const a = stat(cur, k), b = stat(base, k);
      if (!a) { if (b && b.n >= 8) stale.push(cat[k].label || k); continue; }
      const pct = b && b.avg ? ` (${a.avg >= b.avg ? "+" : ""}${Math.round((a.avg - b.avg) / Math.abs(b.avg) * 100)}%)` : "";
      lines.push(`${k}${cat[k].label ? ` "${cat[k].label}"` : ""}${cat[k].unit ? ` [${cat[k].unit}]` : ""}: week ${r2(a.avg)} (${a.n}d)${b ? ` vs 4wk ${r2(b.avg)} (${b.n}d)${pct}` : " (new)"}`);
    }
    return `Metric table (daily average on days logged; d = days with data):\n${lines.slice(0, 400).join("\n")}${stale.length ? `\nStopped updating this week (had data in the 4 weeks before): ${stale.slice(0, 40).join(", ")}` : ""}`;
  }

  async function write({ force = false } = {}) {
    const wk = lastWeek(), m = await dbGetMeta();
    const prev = list(m).find(r => r.week === wk.start);
    if (prev && !force) return prev;
    const key = await getKey(); if (!key) throw new Error("No Anthropic API key configured.");
    await Usage.checkBudget();
    const client = Usage.client(key, "weekly_review");
    const days = await loadDays(), cat = catalog(days);
    if (!days.some(x => x._dateKey >= wk.start && x._dateKey <= wk.end)) throw new Error("No data for last week yet.");
    const system = [{ type: "text", text: systemPrompt(days, cat), cache_control: { type: "ephemeral" } }, { type: "text", text: await extraPrompt() }];
    const messages = [{ role: "user", content:
      `Write my weekly review for ${wk.start} to ${wk.end} (Mon–Sun), comparing it with the 4 weeks before. The table below already has every number you need; only call get_health_data if one specific day-level detail is essential (at most twice). Cover body composition, nutrition, activity and training, sleep and recovery, and my goals and alerts.\n\n${weekTable(days, cat, wk)}\n\n` +
      `Format (markdown, under 250 words, no preamble):\n**Headline:** one sentence on the week.\n**Wins** — 2–3 bullets with numbers (this week vs the 4-week average).\n**Watch** — 1–3 bullets, the most important first.\n**Next week** — exactly 3 specific actions with targets (e.g. "protein ≥ 190 g on 6 of 7 days").\nOnly state numbers from the table or the tool. If a data source stopped updating, say so in Watch.` }];
    let text = "";
    for (let turn = 0; turn < 4; turn++) {
      const last = turn === 3;   // last turn: no tools, write the review now
      const msg = await client.messages.stream({ model, max_tokens: 16000, thinking: { type: "adaptive" }, output_config: { effort: "medium" }, system, messages,
        ...(last ? { tools: [dataTool], tool_choice: { type: "none" } } : { tools: [dataTool] }) }).finalMessage();
      messages.push({ role: "assistant", content: msg.content });
      if (msg.stop_reason !== "tool_use") { text = msg.content.filter(b => b.type === "text").map(b => b.text).join("").trim(); break; }
      messages.push({ role: "user", content: msg.content.filter(b => b.type === "tool_use").map(b => {
        try { return { type: "tool_result", tool_use_id: b.id, content: JSON.stringify(queryMetrics(days, b.input || {})) }; }
        catch (e) { return { type: "tool_result", tool_use_id: b.id, content: "Error: " + e.message, is_error: true }; }
      }) });
    }
    if (!text) throw new Error("The review didn't finish.");
    const r = { week: wk.start, end: wk.end, text, at: new Date().toISOString() };
    await dbSetMeta({ weekly_reviews: [r, ...list(await dbGetMeta()).filter(x => x.week !== wk.start)].slice(0, 26) });
    const head = (text.match(/\*\*Headline:\*\*\s*(.+)/) || [])[1] || "Your weekly review is ready.";
    await notify("BodyData: your week in review", head.replace(/\*\*/g, "").slice(0, 200)).catch(() => {});
    return r;
  }

  app.get("/reviews", auth, async (req, res) => { res.json({ reviews: list(await dbGetMeta()).slice(0, 12), week: lastWeek() }); });
  app.post("/reviews/run", auth, async (req, res) => {
    try { res.json({ ok: true, review: await write({ force: !!req.body?.force }) }); }
    catch (e) { res.status(e.status || 400).json({ error: e.message }); }
  });

  // Sundays 21:30 UTC (≈ 4:30 pm ET); users opt out with meta weekly_review_off
  cron.schedule("30 21 * * 0", async () => {
    for (const uid of await d.allUsers().catch(() => [])) await runAs(uid, async () => {
      try { const m = await dbGetMeta(); if (m.weekly_review_off) return; const r = await write(); console.log(`[review] ${uid}: ${r.week}`); }
      catch (e) { console.error(`[review] ${uid}: ${e.message}`); }
    });
  }, { timezone: "UTC" });

  return { write, lastWeek };
};
