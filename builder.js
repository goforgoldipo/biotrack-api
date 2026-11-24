// ─────────────────────────────────────────────────────────────────
//  The agent as a builder (Lovable-style): Ask AI can add sections, derived metrics,
//  alerts and goals. Every change is
//    preview  → the tool result shows exactly what was built, with real computed values
//    verify   → the agent checks those values before telling the user it's done
//    undo     → each change is a checkpoint; "Undo" restores the state before it
//    approve  → anything that removes things waits for the user to tap Approve
//  State lives in meta (kpi_sections, alerts, goals) so checkpoints are a copy of those keys.
// ─────────────────────────────────────────────────────────────────
const crypto = require("crypto");
const cron = require("node-cron");
const F = require("./formula");
const { currentUser, runAs, OWNER } = require("./tenancy");

const STATE_KEYS = ["kpi_sections", "alerts", "goals"];
const newId = (p) => p + crypto.randomBytes(5).toString("hex");

module.exports = function builder(app, d) {
  const { auth, pool, dbGetMeta, dbSetMeta, loadDays, catalog, S, notify } = d;
  let ready = null;
  const migrate = () => (ready ||= pool.query(`
    CREATE TABLE IF NOT EXISTS changes (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, at TIMESTAMPTZ DEFAULT NOW(), summary TEXT, tool TEXT,
      before JSONB NOT NULL, after JSONB, undone BOOLEAN NOT NULL DEFAULT false);
    ALTER TABLE changes ADD COLUMN IF NOT EXISTS after JSONB;
    CREATE INDEX IF NOT EXISTS idx_changes_user ON changes (user_id, at DESC);`));

  const list = (m, k) => (Array.isArray(m[k]) ? m[k] : []);

  // ── Change tracking + undo. Each change stores the state before and after it; undo puts back
  // only the sections/alerts/goals that change touched, so later uploads and edits survive.
  const snap = async () => { const m = await dbGetMeta(); return Object.fromEntries(STATE_KEYS.map(k => [k, list(m, k)])); };
  async function tracked(summary, tool, fn) {
    await migrate();
    const id = newId("c"), before = await snap();
    await pool.query(`INSERT INTO changes (id, user_id, summary, tool, before) VALUES ($1,$2,$3,$4,$5)`, [id, currentUser(), String(summary).slice(0, 200), tool, before]);
    try {
      const out = await fn(id);
      await pool.query(`UPDATE changes SET after = $2 WHERE id = $1`, [id, await snap()]);
      return { out, id };
    } catch (e) { await pool.query(`DELETE FROM changes WHERE id = $1`, [id]).catch(() => {}); throw e; }
  }
  async function undo(id) {
    await migrate();
    const uid = currentUser();
    const { rows: [c] } = await pool.query(`SELECT * FROM changes WHERE id = $1 AND user_id = $2`, [id, uid]);
    if (!c) throw Object.assign(new Error("No such change"), { status: 404 });
    if (c.undone) return { ok: true, note: "Already undone" };
    const now = await snap(), patch = {}, created = [];
    for (const k of STATE_KEYS) {
      const B = new Map(list(c.before, k).map(x => [x.id, x])), A = new Map(list(c.after || {}, k).map(x => [x.id, x]));
      const touched = [...new Set([...B.keys(), ...A.keys()])].filter(i => JSON.stringify(B.get(i)) !== JSON.stringify(A.get(i)));
      if (!touched.length) continue;
      let L = now[k];
      for (const i of touched) {
        if (B.has(i)) L = L.some(x => x.id === i) ? L.map(x => (x.id === i ? B.get(i) : x)) : [...L, B.get(i)];
        else { L = L.filter(x => x.id !== i); if (k === "kpi_sections") created.push("section:" + i); }
      }
      patch[k] = L;
    }
    if (Object.keys(patch).length) await dbSetMeta(patch);
    // values this change stored, and every value of a section it created
    const r = await pool.query(`DELETE FROM snapshots WHERE user_id = $1 AND (data->>'_batch' = $2 OR data->>'_source' = ANY($3))`, [uid, id, created]);
    await pool.query(`UPDATE changes SET undone = true WHERE id = $1`, [id]);
    d.invalidate();
    return { ok: true, summary: c.summary, valuesRemoved: r.rowCount };
  }
  async function recentChanges(n = 15) {
    await migrate();
    const { rows } = await pool.query(`SELECT id, at, summary, tool, undone FROM changes WHERE user_id = $1 ORDER BY at DESC LIMIT $2`, [currentUser(), n]);
    return rows;
  }

  // ── Current value of a metric: last reading in the past `days`, or a 7-day average
  function series(days, key) { return days.filter(x => typeof x[key] === "number" && isFinite(x[key])).map(x => ({ date: x._dateKey, v: x[key] })); }
  function currentValue(days, key, basis = "day") {
    const s = series(days, key); if (!s.length) return null;
    const last = s[s.length - 1];
    if (basis === "avg7") {
      const from = new Date(new Date(last.date).getTime() - 6 * 864e5).toISOString().slice(0, 10);
      const w = s.filter(x => x.date >= from); return { date: last.date, value: Math.round(w.reduce((a, x) => a + x.v, 0) / w.length * 100) / 100, n: w.length };
    }
    return { date: last.date, value: last.v };
  }
  const known = async () => { const days = await loadDays(); return { days, cat: catalog(days) }; };
  const needKey = (cat, key) => { if (!cat[key]) throw new Error(`Unknown metric "${key}". Use a key from the catalog (get_health_data shows them).`); };

  // ── Alerts
  function alertState(a, days) {
    const cur = currentValue(days, a.metric, a.basis);
    if (!cur) return { ...a, current: null, triggered: false };
    const stale = (Date.now() - new Date(cur.date).getTime()) / 864e5 > (a.basis === "avg7" ? 10 : 4);
    const triggered = !stale && (a.op === "above" ? cur.value > a.value : cur.value < a.value);
    return { ...a, current: cur, triggered, stale };
  }
  async function checkAlerts({ send = true } = {}) {
    const m = await dbGetMeta(), alerts = list(m, "alerts"); if (!alerts.length) return [];
    const days = await loadDays(), fired = [];
    for (const a of alerts) {
      if (a.enabled === false) continue;
      const st = alertState(a, days);
      const quiet = a.lastFired && Date.now() - new Date(a.lastFired).getTime() < (a.cooldownDays || 3) * 864e5;
      if (st.triggered && !quiet) {
        fired.push(st); a.lastFired = new Date().toISOString();
        if (send) await notify(`BodyData: ${a.label}`, a.message || `${a.label}: ${st.current.value} (${a.op} ${a.value}) on ${st.current.date}`).catch(() => {});
      }
    }
    if (fired.length) await dbSetMeta({ alerts, alert_events: [...fired.map(f => ({ id: f.id, label: f.label, value: f.current.value, date: f.current.date, at: new Date().toISOString() })), ...list(m, "alert_events")].slice(0, 50) });
    return fired;
  }

  // ── Goals: progress from the starting value to the target, and whether the current pace gets there by the date
  function goalState(g, days) {
    const s = series(days, g.metric), cur = currentValue(days, g.metric, "avg7");
    if (!cur) return { ...g, current: null };
    const start = g.startValue ?? s.find(x => x.date >= (g.startDate || ""))?.v ?? s[0].v;
    const span = g.target - start, done = span === 0 ? 1 : (cur.value - start) / span;
    const reached = g.target >= start ? cur.value >= g.target : cur.value <= g.target;
    let onTrack = null, projected = null;
    if (g.by) {
      const from = new Date(cur.date).getTime() - 28 * 864e5, recent = s.filter(x => new Date(x.date).getTime() >= from);
      if (recent.length >= 4) {   // least-squares slope over the last 4 weeks
        const t0 = new Date(recent[0].date).getTime(), xs = recent.map(x => (new Date(x.date).getTime() - t0) / 864e5), ys = recent.map(x => x.v);
        const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
        const slope = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / (xs.reduce((a, x) => a + (x - mx) ** 2, 0) || 1);
        const daysLeft = (new Date(g.by).getTime() - new Date(cur.date).getTime()) / 864e5;
        projected = Math.round((cur.value + slope * daysLeft) * 100) / 100;
        onTrack = reached || (g.target >= start ? projected >= g.target : projected <= g.target);
      }
    }
    return { ...g, startValue: start, current: cur, progress: Math.max(0, Math.min(100, Math.round(done * 100))), reached, projected, onTrack };
  }

  // ── Pending approvals (removals)
  async function addPending(tool, input, summary) {
    const m = await dbGetMeta(), p = { id: newId("p"), tool, input, summary, at: new Date().toISOString() };
    await dbSetMeta({ builder_pending: [p, ...list(m, "builder_pending")].slice(0, 20) }); return p;
  }
  async function takePending(id) {
    const m = await dbGetMeta(), all = list(m, "builder_pending"), p = all.find(x => x.id === id);
    if (p) await dbSetMeta({ builder_pending: all.filter(x => x.id !== id) }); return p;
  }

  // Inputs are validated here (these tools aren't grammar-constrained: the API caps strict tools per request)
  function check(tool, i) {
    const bad = (m) => { throw new Error(m); };
    const str = (v, n) => (typeof v === "string" ? v.trim() : bad(`${n} must be text`));
    const num = (v, n) => (typeof v === "number" && isFinite(v) ? v : bad(`${n} must be a number`));
    if (tool === "create_derived_metric") {
      if (!str(i.name, "name")) bad("name is required");
      if (!Array.isArray(i.kpis) || !i.kpis.length || i.kpis.length > 30) bad("kpis: 1–30 items");
      for (const k of i.kpis) { str(k.label, "kpi label"); str(k.formula, "formula"); if (!["up", "down", "neutral"].includes(k.direction)) k.direction = "neutral"; k.unit = String(k.unit || ""); }
    }
    if (tool === "set_alert") {
      str(i.metric, "metric"); str(i.label, "label"); num(i.value, "value");
      if (!["above", "below"].includes(i.op)) bad("op must be above or below");
      if (!["day", "avg7"].includes(i.basis)) i.basis = "avg7";
      i.cooldown_days = Math.min(30, Math.max(1, parseInt(i.cooldown_days) || 3)); i.message = String(i.message || "").slice(0, 300);
    }
    if (tool === "set_goal") {
      str(i.metric, "metric"); str(i.label, "label"); num(i.target, "target");
      if (i.by && !/^\d{4}-\d{2}-\d{2}$/.test(i.by)) bad("by must be YYYY-MM-DD"); i.why = String(i.why || "").slice(0, 300);
    }
    if (tool === "remove") { if (!["section", "alert", "goal"].includes(i.kind)) bad("kind must be section, alert or goal"); str(i.id, "id"); }
    return i;
  }

  // ── Tool implementations (also used by Approve)
  async function apply(tool, input, change) {
    check(tool, input);
    const m = await dbGetMeta();
    if (tool === "create_derived_metric") {
      const { cat, days } = await known();
      for (const k of input.kpis) { for (const v of F.variables(F.parse(k.formula))) needKey(cat, v); }
      const existing = input.section_id ? S.getSections().then(l => l.find(s => s.id === input.section_id)) : null;
      const prev = await existing;
      const sec = await S.saveSection({ id: prev?.id, name: input.name, description: input.description, schedule: "daily", source: { type: "derived", app: "BodyData" },
        kpis: input.kpis.map(k => ({ label: k.label, unit: k.unit, direction: k.direction, aggregate: "last", formula: k.formula, existing_key: "" })) });
      const r = await S.computeDerived(sec, { full: true, batch: change });
      await S.patchSection(sec.id, { lastRun: new Date().toISOString(), lastStatus: { ok: true, text: `Calculated ${r.days} days` }, newest: r.newest });
      // verify: show the agent real numbers so it can sanity-check the formula before reporting
      const after = await loadDays();
      return { ok: true, section_id: sec.id, days_calculated: r.days, first: r.first, newest: r.newest,
        kpis: sec.kpis.map(k => ({ key: k.key, label: k.label, formula: k.formula, last_values: series(after, k.key).slice(-5) })),
        verify: r.days ? "Check last_values look plausible (units, magnitude) before telling the user. If wrong, fix with section_id set." : "No day had every input. Check the metric keys have overlapping dates." };
    }
    if (tool === "set_alert") {
      const { cat, days } = await known(); needKey(cat, input.metric);
      const alerts = list(m, "alerts"), i = alerts.findIndex(a => a.id === input.id);
      const a = { id: i >= 0 ? alerts[i].id : newId("a"), metric: input.metric, label: input.label, op: input.op, value: input.value, basis: input.basis, message: input.message, cooldownDays: input.cooldown_days || 3, enabled: true, createdAt: new Date().toISOString() };
      if (i >= 0) alerts[i] = a; else alerts.push(a);
      await dbSetMeta({ alerts: alerts.slice(0, 50) });
      const st = alertState(a, days);
      return { ok: true, id: a.id, current: st.current, would_trigger_now: st.triggered, stale: !!st.stale, delivery: (m.coaching_ntfy_topic || currentUser() === OWNER) ? "push notification" : "shows on the dashboard (no push set up)" };
    }
    if (tool === "set_goal") {
      const { cat, days } = await known(); needKey(cat, input.metric);
      const goals = list(m, "goals"), i = goals.findIndex(g => g.id === input.id);
      const cur = currentValue(days, input.metric, "avg7");
      const g = { id: i >= 0 ? goals[i].id : newId("g"), metric: input.metric, label: input.label, target: input.target, by: input.by || "", startValue: i >= 0 ? goals[i].startValue : cur?.value ?? null, startDate: i >= 0 ? goals[i].startDate : cur?.date || "", why: input.why, createdAt: new Date().toISOString() };
      if (i >= 0) goals[i] = g; else goals.push(g);
      await dbSetMeta({ goals: goals.slice(0, 30) });
      return { ok: true, ...goalState(g, days) };
    }
    if (tool === "remove") {
      if (input.kind === "section") {
        const l = await S.getSections(); if (!l.some(s => s.id === input.id)) throw new Error("No such section");
        await S.putSections(l.filter(s => s.id !== input.id));
      } else {
        const k = input.kind === "alert" ? "alerts" : "goals";
        if (!list(m, k).some(x => x.id === input.id)) throw new Error(`No such ${input.kind}`);
        await dbSetMeta({ [k]: list(m, k).filter(x => x.id !== input.id) });
      }
      return { ok: true, removed: input.kind, id: input.id };
    }
    return null;
  }
  const summaryOf = (tool, i) => tool === "create_derived_metric" ? `${i.section_id ? "Updated" : "Added"} “${i.name}” (${i.kpis.map(k => k.label).join(", ")})`
    : tool === "set_alert" ? `Alert: ${i.label} (${i.metric} ${i.op} ${i.value})` : tool === "set_goal" ? `Goal: ${i.label} → ${i.target}${i.by ? " by " + i.by : ""}`
    : tool === "remove" ? `Remove ${i.kind} ${i.label || i.id}` : tool === "save_kpi_section" ? `${i.id ? "Updated" : "Added"} section “${i.name}”` : tool === "record_values" ? `Recorded ${(i.rows || []).length} date(s) of results` : tool;

  // Ask AI calls this for every build tool. `emit` streams change/approval cards to the chat.
  async function runTool(name, input, emit = () => {}, sectionTool = (n, i, c) => S.runTool(n, i, c)) {
    if (name === "remove" || name === "delete_kpi_section") {
      const inp = check("remove", name === "delete_kpi_section" ? { kind: "section", id: input.id, label: "" } : input);
      const p = await addPending("remove", inp, summaryOf("remove", inp));
      emit({ type: "approve", id: p.id, summary: p.summary });
      return { ok: true, pending_approval: p.id, note: "Shown to the user with an Approve button. Tell them it's waiting for their approval; don't call this again." };
    }
    const SECTION_TOOLS = ["save_kpi_section", "record_values"];   // implemented in sections.js
    if (!["create_derived_metric", "set_alert", "set_goal", ...SECTION_TOOLS].includes(name)) return null;
    const summary = summaryOf(name, input);
    const { out, id } = await tracked(summary, name, async (change) => {
      const out = SECTION_TOOLS.includes(name) ? await sectionTool(name, input, change) : await apply(name, input, change);
      if (out == null) throw new Error(`${name} did nothing`);   // never report a change that didn't happen
      return out;
    });
    emit({ type: "change", id, summary });
    return { ...out, change_id: id };
  }

  const kpiF = { type: "object", additionalProperties: false, required: ["label", "unit", "direction", "formula"], properties: {
    label: { type: "string" }, unit: { type: "string" }, direction: { type: "string", enum: ["up", "down", "neutral"] },
    formula: { type: "string", description: "Arithmetic over metric keys (+ - * / ^ parentheses), functions abs, round, sqrt, log, exp, min(a,b), max(a,b), if(cond>0,a,b), and rolling avg(key,days), sum(key,days), count(key,days), min7(key,days), max7(key,days), prev(key,n), delta(key,days), pct_change(key,days). E.g. 'weight * (1 - bodyFat/100)', 'protein / weight', 'avg(hrv,7) - avg(hrv,28)'" },
  } };
  const tools = [
    { name: "create_derived_metric",
      description: "Build new KPIs computed from metrics the user already has (ratios, rolling averages, baselines, combinations), shown as a dashboard section that recalculates daily. Returns the computed values so you can verify them. Pass section_id to fix or extend one you made.",
      input_schema: { type: "object", additionalProperties: false, required: ["section_id", "name", "description", "kpis"], properties: {
        section_id: { type: "string", description: "Existing derived section to update, or empty" }, name: { type: "string" }, description: { type: "string" },
        kpis: { type: "array", items: kpiF } } } },
    { name: "set_alert",
      description: "Create or update an alert that notifies the user when a metric crosses a threshold (e.g. resting HR 7-day average above 60, HRV below 35, glucose above 140). Returns the current value and whether it would fire now.",
      input_schema: { type: "object", additionalProperties: false, required: ["id", "metric", "label", "op", "value", "basis", "message", "cooldown_days"], properties: {
        id: { type: "string", description: "Existing alert id to update, or empty" }, metric: { type: "string", description: "Metric key from the catalog" }, label: { type: "string" },
        op: { type: "string", enum: ["above", "below"] }, value: { type: "number" },
        basis: { type: "string", enum: ["day", "avg7"], description: "Latest daily value, or the 7-day average (less noisy)" },
        message: { type: "string", description: "What to tell the user when it fires, with the action to take" },
        cooldown_days: { type: "integer", description: "Minimum days between notifications (default 3)" } } } },
    { name: "set_goal",
      description: "Create or update a goal for a metric with an optional target date. Returns progress and whether the current 4-week trend reaches it in time.",
      input_schema: { type: "object", additionalProperties: false, required: ["id", "metric", "label", "target", "by", "why"], properties: {
        id: { type: "string", description: "Existing goal id, or empty" }, metric: { type: "string" }, label: { type: "string" }, target: { type: "number" },
        by: { type: "string", description: "YYYY-MM-DD or empty" }, why: { type: "string", description: "One line on why this target, shown with the goal" } } } },
    { name: "remove",
      description: "Remove a section, alert or goal. Waits for the user to tap Approve in the chat.",
      input_schema: { type: "object", additionalProperties: false, required: ["kind", "id", "label"], properties: {
        kind: { type: "string", enum: ["section", "alert", "goal"] }, id: { type: "string" }, label: { type: "string", description: "Its name, shown on the Approve card" } } } },
  ];
  async function promptBlock() {
    const m = await dbGetMeta(), days = await loadDays();
    const al = list(m, "alerts").map(a => alertState(a, days)), gl = list(m, "goals").map(g => goalState(g, days));
    return `\n\nYou can build, not just advise (like a full-stack engineer for the user's health data): create_derived_metric for new calculated KPIs, set_alert for notifications, set_goal for targets, save_kpi_section for new data sources, remove to delete (the user approves). When the user asks for something BodyData doesn't do yet, build it with these tools rather than explaining how they could. Work like this: build → read the values the tool returns → if they look wrong (units, magnitude, empty), fix and rebuild → then tell the user what you built in one or two lines with a real number from it. Every change shows an Undo button; mention it only if the user seems unsure.` +
      `\nAlerts: ${al.length ? al.map(a => `${a.id} "${a.label}" ${a.metric} ${a.op} ${a.value} (${a.basis}) now ${a.current?.value ?? "no data"}${a.triggered ? " TRIGGERED" : ""}`).join("; ") : "none"}` +
      `\nGoals: ${gl.length ? gl.map(g => `${g.id} "${g.label}" ${g.metric} → ${g.target}${g.by ? " by " + g.by : ""}: now ${g.current?.value ?? "?"}, ${g.progress ?? 0}%${g.onTrack === false ? ", OFF TRACK (projected " + g.projected + ")" : g.onTrack ? ", on track" : ""}`).join("; ") : "none"}`;
  }

  // ── Routes
  app.get("/builder/state", auth, async (req, res) => {
    try {
      const m = await dbGetMeta(), days = await loadDays();
      res.json({ alerts: list(m, "alerts").map(a => alertState(a, days)), goals: list(m, "goals").map(g => goalState(g, days)),
        events: list(m, "alert_events").slice(0, 20), pending: list(m, "builder_pending"), changes: await recentChanges() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post("/builder/undo/:id", auth, async (req, res) => {
    try { res.json(await undo(req.params.id)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });
  app.post("/builder/approve/:id", auth, async (req, res) => {
    try {
      const p = await takePending(req.params.id); if (!p) return res.status(404).json({ error: "Already handled" });
      if (req.body?.deny) return res.json({ ok: true, denied: true });
      const { out, id } = await tracked(p.summary, p.tool, (change) => apply(p.tool, p.input, change));
      res.json({ ...out, change_id: id, summary: p.summary });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // The same build tools without AI (dashboard forms, the Mac agent, tests). Removals still need Approve.
  app.post("/builder/tool/:name", auth, async (req, res) => {
    try {
      if (!tools.some(t => t.name === req.params.name)) return res.status(404).json({ error: "No such tool" });
      const events = [];
      res.json({ ...(await runTool(req.params.name, req.body || {}, (e) => events.push(e))), events });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  // Manual edits from the dashboard (toggle/delete an alert or goal) — same checkpoints
  app.post("/builder/:kind(alert|goal)/:id/delete", auth, async (req, res) => {
    try { const { out, id } = await tracked(`Removed ${req.params.kind}`, "remove", (c) => apply("remove", { kind: req.params.kind, id: req.params.id }, c)); res.json({ ...out, change_id: id }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Alerts are checked a few times a day (after morning and evening syncs)
  cron.schedule("15 12,18,23 * * *", async () => {
    for (const uid of await d.allUsers().catch(() => [])) await runAs(uid, async () => {
      try { const f = await checkAlerts(); if (f.length) console.log(`[alerts] ${uid}: ${f.length} fired`); } catch (e) { console.error(`[alerts] ${uid}: ${e.message}`); }
    });
  }, { timezone: "UTC" });

  return { tools, runTool, promptBlock, undo, tracked, checkAlerts, alertState, goalState, migrate };
};
