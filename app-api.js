// ─────────────────────────────────────────────────────────────────
//  /app/* — ready-made screens for the native iPhone app.
//  Uses the exact same KPI + benchmark engine as the web dashboard
//  (shared/*.mjs, copied from biotrack-dashboard/src/shared by `npm run sync-shared`),
//  so the phone always shows the same numbers as the web.
// ─────────────────────────────────────────────────────────────────
const { currentUser } = require("./tenancy");
module.exports = function registerAppApi(app, { auth, pool, dbGetMeta, dbGetHistory, dedupHistory, profileApi }) {
  let K, B;
  const engine = async () => {
    if (!K) { K = await import("./shared/kpi.mjs"); B = await import("./shared/bench.mjs"); }
    return { K, B };
  };
  // Rebuilt whenever anything new is written (latest received_at changes), so imports show instantly
  const caches = new Map();   // per user
  async function rows() {
    const { K } = await engine(); const uid = currentUser();
    const { rows: m } = await pool.query(`SELECT MAX(received_at) AS t, COUNT(*) AS n FROM snapshots WHERE user_id = $1`, [uid]);
    const stamp = `${m[0]?.t?.toISOString?.() || ""}|${m[0]?.n}`;
    const c = caches.get(uid); if (c?.rows && c.stamp === stamp) return c;
    const r = dedupHistory(await dbGetHistory(20000), 20000).map(K.mapImport);
    const out = { stamp, rows: r, idx: K.dayIndex(r) };
    if (caches.size > 200) caches.delete(caches.keys().next().value);
    caches.set(uid, out); return out;
  }
  async function context() {
    const meta = await dbGetMeta();
    const profile = profileApi ? await profileApi.getProfile().catch(() => ({})) : {};
    return { sections: Array.isArray(meta.kpi_sections) ? meta.kpi_sections : [], prefs: meta.dashboard_prefs || {}, profile };
  }
  const rangeOf = (q) => q.range === "custom" ? { p: "custom", a: q.a, b: q.b } : { p: q.range || "thismonth" };
  const slimCard = (c) => ({
    id: c.id, key: c.k, label: c.label, unit: c.unit || "", group: c.gid, source: c.src,
    value: c.value ?? null, fmt: c.fmt, prev: c.prev ?? null, prevFmt: c.prevFmt || "—", delta: c.delta ?? null,
    pts: !!c.pts, lowerBetter: !!c.lb, neutral: !!c.neu, mode: c.mode, sub: c.sub || "", text: !!c.text,
    vals: c.vals || [], labels: c.labels || [], apps: c.apps || [], partial: !!c.partial,
  });

  // Range presets the phone can offer (same as web)
  app.get("/app/ranges", auth, async (_req, res) => {
    const { K } = await engine();
    res.json({ ranges: [...K.DK_PRESETS.map(([id, label]) => ({ id, label })), { id: "all", label: "All time" }] });
  });

  // KPI board: every section with its cards, in the user's saved order, hidden cards removed
  app.get("/app/board", auth, async (req, res) => {
    try {
      const { K } = await engine(); const { rows: data } = await rows(); const { sections, prefs, profile } = await context();
      const R = rangeOf(req.query), r = R.p === "all" ? K.resolveRange(R, (await rows()).idx) : { ...K.dkRange(R), label: K.dkLabel(R) };
      const board = K.buildKpiBoard(data, r, sections);
      const hidden = new Set(prefs.kpiHidden || []), order = prefs.kpiOrder || {};
      const groups = [...K.GROUPS, ...board.extraGroups].map(g => {
        const saved = order[g.id] || [], pos = id => { const i = saved.indexOf(id); return i < 0 ? 1e6 : i; };
        const cards = (board.groups[g.id] || []).map((c, i) => [c, i]).sort((a, b) => (pos(a[0].id) - pos(b[0].id)) || (a[1] - b[1])).map(x => x[0])
          .filter(c => req.query.all === "1" || !hidden.has(c.k)).map(c => ({ ...slimCard(c), hidden: hidden.has(c.k) }));
        return { id: g.id, name: g.name.replace(/^APPLE HEALTH · /, ""), source: g.src, description: K.GROUP_DESC[g.id] || g.desc || "", cards };
      }).filter(g => g.cards.length && !board.emptyGroups?.has(g.id));
      // The user's goal decides which sections come first
      const pri = profileApi ? profileApi.goalGroups(profile) : [];
      groups.sort((a, b) => { const ia = pri.indexOf(a.id), ib = pri.indexOf(b.id); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib); });
      const goal = profileApi ? await profileApi.goalProgress(profile).catch(() => null) : null;
      res.json({ range: { id: R.p, label: r.label, a: r.a, b: r.b, compareLabel: r.cmpLbl, span: K.fmtSpan(r.a, r.b) }, goal, groups });
    } catch (e) { console.error("/app/board", e); res.status(500).json({ error: e.message }); }
  });

  // Metrics list: every metric that has ever had data, grouped (left nav on web)
  app.get("/app/metrics", auth, async (req, res) => {
    try {
      const { K } = await engine(); const { rows: data, idx } = await rows(); const { sections } = await context();
      const board = K.buildKpiBoard(data, K.dkRange({ p: "l30" }), sections);
      const has = new Set(); for (const d of idx.values()) for (const k in d) if (typeof d[k] === "number" && isFinite(d[k])) has.add(k);
      const groups = [...K.GROUPS, ...board.extraGroups].map(g => ({ id: g.id, name: g.name.replace(/^APPLE HEALTH · /, ""),
        metrics: (board.groups[g.id] || []).filter(c => !c.text && has.has(c.k)).map(c => ({ id: c.id, key: c.k, label: c.label, unit: c.unit || "" })) }))
        .filter(g => g.metrics.length);
      res.json({ groups });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // One metric in depth: trend, comparisons, weekday pattern, distribution values, sources
  // Same measure from several sources: standard metric, or a report KPI linked to one with sameAs
  function bySource(K, idx, sections, c) {
    const own = sections.flatMap(s => s.kpis).find(k => k.key === c.k);
    const key = K.COMPARABLE.includes(c.k) ? c.k : own?.sameAs; if (!key) return [];
    const unit = K.SUMMARY_METRICS.find(m => m.key === key)?.unit || c.unit;
    return K.sourceCompare(idx, sections, key, unit);
  }
  app.get("/app/metric", auth, async (req, res) => {
    try {
      const { K } = await engine(); const { rows: data, idx } = await rows(); const { sections } = await context();
      const r = K.resolveRange(rangeOf(req.query), idx);
      const board = K.buildKpiBoard(data, r, sections);
      const c = board.byId[req.query.id] || Object.values(board.byId).find(x => x.k === req.query.key);
      if (!c || c.text) return res.status(404).json({ error: "No such metric" });
      const d = K.metricDetail(idx, c, r, req.query.gran || "auto");
      res.json({ range: { id: req.query.range || "thismonth", label: r.label, a: r.a, b: r.b, compareLabel: r.cmpLbl, span: K.fmtSpan(r.a, r.b) },
        card: slimCard(c), granularity: d.g, perDay: d.perDay, how: d.how,
        series: d.buckets.map(b => ({ label: b.label, date: b.key, value: b.v })),
        comparisons: d.cmp.map(x => ({ label: x.l, value: x.v, fmt: x.fmt, delta: x.d })),
        weekday: d.weekday.map(w => ({ day: w.day, value: w.v })), bestDay: d.bestDay,
        daily: d.daily.map(([date, value]) => ({ date, value })), sources: d.sources.map(([name, days]) => ({ name, days })),
        bySource: bySource(K, idx, sections, c) });
    } catch (e) { console.error("/app/metric", e); res.status(500).json({ error: e.message }); }
  });

  // Benchmarks against public data for the user's age + sex
  app.get("/app/benchmarks", auth, async (_req, res) => {
    try {
      const { K, B } = await engine(); const { idx } = await rows(); const { sections, prefs, profile } = await context();
      const days = [...idx.entries()].map(([date, d]) => ({ ...d, date }));
      const prof = profile?.sex ? { sex: profile.sex, birthYear: profile.birthYear } : prefs.profile;
      const out = B.benchmarkList(days, sections, prof);
      res.json({ ...out, profile: prof || null, optIn: !!prefs.benchmarkOptIn, crowdMin: B.CROWD_MIN, membersReady: false });
    } catch (e) { console.error("/app/benchmarks", e); res.status(500).json({ error: e.message }); }
  });
};
