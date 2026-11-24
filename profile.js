// ─────────────────────────────────────────────────────────────────
//  USER PROFILE — onboarding questionnaire answers, stored per user (user_profiles table).
//  Drives: Home ordering, the goal card, benchmark cohort, units, Ask AI context, app guides.
//  Until accounts ship (Phase 1) every request with the shared key is the "owner" user.
// ─────────────────────────────────────────────────────────────────
const { currentUser } = require("./tenancy");
const userId = (_req) => currentUser();   // set by auth for every request

const GOALS = [
  { id: "lose_fat", label: "Lose body fat", icon: "flame.fill", metrics: ["bodyFat", "weight", "fatMass", "waistIn"], groups: ["body", "nutrition", "activity", "measurements"] },
  { id: "build_muscle", label: "Build muscle", icon: "figure.strengthtraining.traditional", metrics: ["leanMass", "weight", "muscleMass"], groups: ["body", "training", "nutrition", "segmental"] },
  { id: "sleep_recovery", label: "Sleep & recover better", icon: "moon.zzz.fill", metrics: ["sleepDur", "hrv", "restingHR"], groups: ["sleep", "hk_sleep", "hk_heart", "activity"] },
  { id: "endurance", label: "Boost endurance", icon: "figure.run", metrics: ["vo2max", "restingHR", "steps"], groups: ["activity", "hk_activity", "hk_heart", "training"] },
  { id: "longevity", label: "Live longer & healthier", icon: "heart.text.square.fill", metrics: ["vo2max", "hrv", "restingHR", "bodyFat"], groups: ["sleep", "hk_heart", "body", "activity"] },
  { id: "general", label: "Feel better overall", icon: "sparkles", metrics: ["steps", "weight", "sleepDur"], groups: ["activity", "sleep", "body", "nutrition"] },
];
// Goal targets: which metric, its unit, and which way is progress
const TARGETS = {
  bodyFat: { label: "Body fat", unit: "%", dir: "down", win: "last" },
  weight: { label: "Weight", unit: "lbs", dir: "either", win: "last" },
  fatMass: { label: "Fat mass", unit: "lbs", dir: "down", win: "last" },
  leanMass: { label: "Lean mass", unit: "lbs", dir: "up", win: "last" },
  muscleMass: { label: "Muscle mass", unit: "lbs", dir: "up", win: "last" },
  waistIn: { label: "Waist", unit: "in", dir: "down", win: "last" },
  sleepDur: { label: "Sleep per night", unit: "hrs", dir: "up", win: "avg" },
  hrv: { label: "HRV", unit: "ms", dir: "up", win: "avg" },
  restingHR: { label: "Resting heart rate", unit: "bpm", dir: "down", win: "avg" },
  vo2max: { label: "VO2 max", unit: "", dir: "up", win: "last" },
  steps: { label: "Daily steps", unit: "", dir: "up", win: "avg" },
};
// Apps people pick in onboarding → how BodyData gets their data (from the top-25 research)
const APPS = [
  { id: "apple_watch", name: "Apple Watch", cat: "Wearables", how: "Automatic via Apple Health." },
  { id: "oura", name: "Oura", cat: "Wearables", how: "Sleep, heart rate and activity arrive via Apple Health. Readiness and sleep scores need the Oura connection (coming soon)." },
  { id: "whoop", name: "WHOOP", cat: "Wearables", how: "Sleep and workouts arrive via Apple Health. Recovery and strain: export from WHOOP (App Settings → Data Export) and share the file to BodyData." },
  { id: "garmin", name: "Garmin", cat: "Wearables", how: "Arrives via Apple Health. Body Battery and stress need a Garmin personal API key (Automations)." },
  { id: "fitbit", name: "Fitbit", cat: "Wearables", how: "Turn on Apple Health sync in the Google Health app." },
  { id: "myfitnesspal", name: "MyFitnessPal", cat: "Nutrition", how: "Calories and macros arrive via Apple Health (MyFitnessPal → Settings → Sharing → Apple Health). Per-food detail: email yourself the export and share it to BodyData.AI." },
  { id: "cronometer", name: "Cronometer", cat: "Nutrition", how: "Some nutrients arrive via Apple Health. Full micronutrients: export CSV on cronometer.com and upload it." },
  { id: "macrofactor", name: "MacroFactor", cat: "Nutrition", how: "Arrives via Apple Health. Expenditure trend: Data Export → Share → BodyData.AI." },
  { id: "fitbod", name: "Fitbod", cat: "Training", how: "Workouts arrive via Apple Health. Sets, reps and weights: Fitbod → Log → ⋯ → Export → Share → BodyData.AI (weekly reminder in More)." },
  { id: "strong", name: "Strong", cat: "Training", how: "Export all data as CSV and share it to BodyData.AI." },
  { id: "hevy", name: "Hevy", cat: "Training", how: "Workouts arrive via Apple Health. Full sets and reps: paste your Hevy API key (Hevy Pro) in a custom section." },
  { id: "peloton", name: "Peloton", cat: "Training", how: "Workouts arrive via Apple Health. Output and classes: download the CSV on onepeloton.com and upload it." },
  { id: "strava", name: "Strava", cat: "Training", how: "Activities arrive via Apple Health." },
  { id: "withings", name: "Withings", cat: "Body composition", how: "Weight and body fat arrive via Apple Health." },
  { id: "hume", name: "Hume", cat: "Body composition", how: "Weight arrives via Apple Health. Segmental and visceral fat: screenshot the scan and share it to BodyData.AI." },
  { id: "renpho", name: "Renpho", cat: "Body composition", how: "Body fat and lean mass arrive via Apple Health. Extras: share a screenshot to BodyData." },
  { id: "inbody", name: "InBody", cat: "Body composition", how: "Photo or PDF of your result sheet → share to BodyData.AI." },
  { id: "dexa", name: "DEXA scans", cat: "Body composition", how: "Share the scan PDF to BodyData; every result becomes a KPI." },
  { id: "dexcom", name: "Dexcom / Stelo", cat: "Glucose", how: "Glucose arrives via Apple Health (3-hour delay)." },
  { id: "libre", name: "Libre / Lingo", cat: "Glucose", how: "Lingo writes to Apple Health. Libre: download the CSV from LibreView and upload it." },
  { id: "function_health", name: "Function Health", cat: "Labs", how: "Download your results PDF and share it to BodyData.AI." },
  { id: "labs_other", name: "Other lab tests", cat: "Labs", how: "Share any lab PDF to BodyData; the AI reads every biomarker." },
];

module.exports = function registerProfile(app, { auth, pool, dbGetMeta, loadDays, dedupHistory }) {
  const ready = pool.query(`CREATE TABLE IF NOT EXISTS user_profiles (
      user_id TEXT PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`).catch(e => console.error("user_profiles:", e.message));

  // Days in the dashboard's field names (sleepDur, bodyFat…), oldest → newest
  let mcache = { at: 0, days: null };
  async function mappedDays() {
    const raw = await loadDays(); if (mcache.days && mcache.src === raw) return mcache.days;
    const K = await import("./shared/kpi.mjs");
    const days = raw.map(d => ({ ...K.mapImport(d), _dateKey: d._dateKey }));
    mcache = { src: raw, days }; return days;
  }
  async function getProfile(uid = currentUser()) {
    await ready;
    const { rows } = await pool.query(`SELECT data FROM user_profiles WHERE user_id = $1`, [uid]);
    let p = rows[0]?.data || null;
    if (!p) {   // carry over the benchmark answers saved before profiles existed
      const old = (await dbGetMeta()).dashboard_prefs?.profile;
      if (old?.sex || old?.birthYear) p = { sex: old.sex || null, birthYear: old.birthYear || null };
    }
    return p || {};
  }
  async function putProfile(uid, p) {
    await ready;
    await pool.query(`INSERT INTO user_profiles (user_id, data) VALUES ($1, $2)
      ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`, [uid, JSON.stringify(p)]);
  }

  // Latest reading (or recent average) of a metric
  function currentOf(days, key) {
    const t = TARGETS[key]; const recent = days.slice(-60);
    if (t?.win === "avg") {
      const v = days.slice(-14).map(d => d[key]).filter(x => typeof x === "number" && isFinite(x));
      return v.length ? { value: v.reduce((a, b) => a + b, 0) / v.length, date: days[days.length - 1]?._dateKey } : null;
    }
    for (let i = recent.length - 1; i >= 0; i--) { const v = recent[i][key]; if (typeof v === "number" && isFinite(v)) return { value: v, date: recent[i]._dateKey }; }
    return null;
  }
  // Least-squares slope per day over the last 45 days → projected date
  function trendOf(days, key) {
    const pts = days.slice(-45).map(d => [Date.parse(d._dateKey) / 864e5, d[key]]).filter(p => typeof p[1] === "number" && isFinite(p[1]));
    if (pts.length < 6) return null;
    const n = pts.length, mx = pts.reduce((a, p) => a + p[0], 0) / n, my = pts.reduce((a, p) => a + p[1], 0) / n;
    const den = pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0); if (!den) return null;
    return pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / den;
  }
  async function goalProgress(p) {
    const t = p?.target; if (!t?.metric || typeof t.value !== "number") return null;
    const meta = TARGETS[t.metric] || { label: t.metric, unit: "" };
    const days = await mappedDays();
    const cur = currentOf(days, t.metric); if (!cur) return { ...t, label: meta.label, unit: meta.unit, current: null, note: "No recent data for this metric yet." };
    const start = typeof t.start === "number" ? t.start : cur.value;
    const span = t.value - start, done = cur.value - start;
    const pct = span === 0 ? 100 : Math.max(0, Math.min(100, done / span * 100));
    const slope = trendOf(days, t.metric);   // units per day
    let projected = null;
    if (slope && Math.sign(slope) === Math.sign(t.value - cur.value) && Math.abs(t.value - cur.value) > 0) {
      const daysLeft = (t.value - cur.value) / slope;
      if (daysLeft > 0 && daysLeft < 3650) projected = new Date(Date.now() + daysLeft * 864e5).toISOString().slice(0, 10);
    }
    const reached = span === 0 || (span < 0 ? cur.value <= t.value : cur.value >= t.value);
    const onTrack = reached || (projected && (!t.by || projected <= t.by));
    return { metric: t.metric, label: meta.label, unit: meta.unit, target: t.value, by: t.by || null, start, startDate: t.startDate || null,
      current: Math.round(cur.value * 10) / 10, currentDate: cur.date, pct: Math.round(pct), perWeek: slope ? Math.round(slope * 7 * 100) / 100 : null,
      projected, reached, onTrack: !!onTrack };
  }

  function clean(input, prev, latest) {
    const p = { ...prev };
    const s = input || {};
    // Several goals allowed; the first one is the main goal (drives Home order). `goal` kept for older clients.
    if (s.goals !== undefined) { p.goals = [...new Set((Array.isArray(s.goals) ? s.goals : []).filter(id => GOALS.some(g => g.id === id)))].slice(0, 6); p.goal = p.goals[0] || null; }
    else if (s.goal !== undefined) { p.goal = GOALS.some(g => g.id === s.goal) ? s.goal : null; p.goals = p.goal ? [p.goal, ...(prev.goals || []).filter(x => x !== p.goal)] : []; }
    if (s.sex !== undefined) p.sex = ["male", "female"].includes(s.sex) ? s.sex : null;
    if (s.birthYear !== undefined) p.birthYear = Math.min(2015, Math.max(1920, parseInt(s.birthYear) || 0)) || null;
    if (s.heightIn !== undefined) p.heightIn = Math.min(96, Math.max(36, parseFloat(s.heightIn) || 0)) || null;
    if (s.units !== undefined) p.units = s.units === "metric" ? "metric" : "imperial";
    if (s.apps !== undefined) p.apps = (Array.isArray(s.apps) ? s.apps : []).filter(a => APPS.some(x => x.id === a)).slice(0, 40);
    if (s.trainingDays !== undefined) p.trainingDays = s.trainingDays == null ? null : Math.min(7, Math.max(0, parseInt(s.trainingDays) || 0));
    if (s.diet !== undefined) p.diet = String(s.diet || "").slice(0, 60) || null;
    if (s.notes !== undefined) p.notes = String(s.notes || "").slice(0, 500) || null;
    if (s.target !== undefined) {
      const t = s.target;
      if (!t || !TARGETS[t.metric] || !isFinite(parseFloat(t.value))) p.target = null;
      else {
        const same = prev.target && prev.target.metric === t.metric;
        p.target = { metric: t.metric, value: parseFloat(t.value), by: /^\d{4}-\d{2}-\d{2}$/.test(t.by || "") ? t.by : null,
          start: same ? prev.target.start : latest?.[t.metric]?.value ?? null, startDate: same ? prev.target.startDate : latest?.[t.metric]?.date ?? new Date().toISOString().slice(0, 10) };
      }
    }
    if (s.completed) p.completedAt = p.completedAt || new Date().toISOString();
    return p;
  }

  const options = () => ({ goals: GOALS, targets: Object.entries(TARGETS).map(([id, t]) => ({ id, ...t })), apps: APPS });

  app.get("/profile", auth, async (req, res) => {
    try { const p = await getProfile(userId(req)); res.json({ profile: p, goal: await goalProgress(p), options: options() }); }
    catch (e) { console.error("/profile", e); res.status(500).json({ error: e.message }); }
  });
  app.post("/profile", auth, async (req, res) => {
    try {
      const uid = userId(req), prev = await getProfile(uid);
      const days = await mappedDays(), latest = {};
      if (req.body?.target?.metric) { const c = currentOf(days, req.body.target.metric); if (c) latest[req.body.target.metric] = c; }
      const p = clean(req.body, prev, latest);
      await putProfile(uid, p);
      res.json({ ok: true, profile: p, goal: await goalProgress(p) });
    } catch (e) { console.error("/profile", e); res.status(400).json({ error: e.message }); }
  });

  function goalIds(p) { return p?.goals?.length ? p.goals : p?.goal ? [p.goal] : []; }
  async function promptBlock() {
    const p = await getProfile(); if (!p || !Object.keys(p).length) return "";
    const gs = goalIds(p).map(id => GOALS.find(x => x.id === id)).filter(Boolean), gp = await goalProgress(p).catch(() => null);
    const age = p.birthYear ? new Date().getFullYear() - p.birthYear : null;
    const apps = (p.apps || []).map(a => APPS.find(x => x.id === a)?.name).filter(Boolean);
    return `\n\nAbout the user (from their profile): ${[gs.length && `goals: ${gs.map(x => x.label.toLowerCase()).join(", ")} (main: ${gs[0].label.toLowerCase()})`, p.sex, age && `${age} years old`, p.heightIn && `${Math.floor(p.heightIn / 12)}'${Math.round(p.heightIn % 12)}"`,
      p.trainingDays != null && `trains ${p.trainingDays} days/week`, p.diet && `diet: ${p.diet}`, apps.length && `uses ${apps.join(", ")}`, p.units === "metric" && "prefers metric units"].filter(Boolean).join("; ")}.` +
      (gp ? ` Goal target: ${gp.label} ${gp.target}${gp.unit === "%" ? "%" : gp.unit ? " " + gp.unit : ""}${gp.by ? ` by ${gp.by}` : ""}; now ${gp.current ?? "unknown"} (started at ${gp.start}), ${gp.pct}% of the way${gp.projected ? `, projected ${gp.projected}` : ""}.` : "") +
      (p.notes ? ` Notes from the user: ${p.notes}` : "") + " Tailor advice to this goal.";
  }
  // Sections for every chosen goal, main goal's first
  const goalGroups = (p) => [...new Set(goalIds(p).flatMap(id => GOALS.find(g => g.id === id)?.groups || []))];
  return { getProfile, goalProgress, promptBlock, goalGroups, userId };
};
