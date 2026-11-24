// Shared benchmark engine (web + API for the iPhone app). Pure JS.
import { BENCH_REF } from "./benchRef.mjs";

export const CROWD_MIN = 25;

export const labRe = (re) => (d, sections) => {
  for (const s of sections || []) for (const k of s.kpis || []) if (re.test(k.label) && typeof d[k.key] === "number") return d[k.key];
  return null;
};
export const num = (...vals) => { for (const v of vals) if (typeof v === "number" && isFinite(v)) return v; return null; };
// key → how to read the user's value. win: "last" (latest reading in 12 months) or "avg" (last 30 days)
export const BENCH_METRICS = [
  { key: "bodyFat", label: "Body fat", unit: "%", dir: "down", win: "last", get: d => num(d.bodyFat, d.hk_bodyFatPercentage) },
  { key: "vo2max", label: "VO2 max", unit: "mL/kg/min", dir: "up", win: "last", get: d => num(d.vo2max, d.hk_vO2Max) },
  { key: "restingHR", label: "Resting heart rate", unit: "bpm", dir: "down", win: "avg", get: d => num(d.restingHR, d.hk_restingHeartRate) },
  { key: "hrvSDNN", label: "HRV (SDNN)", unit: "ms", dir: "up", win: "avg", get: d => num(d.hrv, d.hk_heartRateVariabilitySDNN) },
  { key: "steps", label: "Daily steps", unit: "", dir: "up", win: "avg", get: d => num(d.steps, d.hk_stepCount) },
  { key: "sleepHours", label: "Sleep", unit: "hrs", dir: "up", win: "avg", get: d => num(d.sleepDur) },
  { key: "bmi", label: "BMI", unit: "", dir: "neutral", win: "last", get: d => num(d.bmi, d.hk_bodyMassIndex) },
  { key: "waistIn", label: "Waist", unit: "in", dir: "down", win: "last", get: d => num(d.waistIn) },
  { key: "leanMassIndex", label: "Lean mass index", unit: "kg/m²", dir: "up", win: "last", get: () => null },
  { key: "ldl", label: "LDL cholesterol", unit: "mg/dL", dir: "down", win: "last", get: labRe(/\bLDL\b(?!.*(particle|size|small))/i) },
  { key: "hba1c", label: "HbA1c", unit: "%", dir: "down", win: "last", get: labRe(/a1c/i) },
  { key: "fastingGlucose", label: "Fasting glucose", unit: "mg/dL", dir: "down", win: "last", get: labRe(/^(fasting )?glucose$/i) },
  { key: "testosterone", label: "Testosterone", unit: "ng/dL", dir: "up", win: "last", get: labRe(/^(total )?testosterone(, total)?$/i), sex: "male" },
  { key: "vitaminD", label: "Vitamin D", unit: "ng/mL", dir: "up", win: "last", get: labRe(/vitamin d|25.?(oh|hydroxy)/i) },
];

export function ageBand(age, bands) {
  if (!age || !bands?.length) return null;
  if (bands.includes("all")) return "all";
  if (bands.every(b => /^\d+$/.test(b))) return bands.reduce((a, b) => Math.abs(+b - age) < Math.abs(+a - age) ? b : a);   // single ages: nearest
  const span = b => { const m = b.match(/^(\d+)(?:-(\d+)|\+)?$/); return [+m[1], m[2] ? +m[2] : b.endsWith("+") ? 200 : +m[1]]; };
  for (const b of bands) { const [lo, hi] = span(b); if (age >= lo && age <= hi) return b; }
  return age < span(bands[0])[0] ? bands[0] : bands[bands.length - 1];
}
export const bandLabel = b => b === "all" ? "all ages" : /^\d+$/.test(b) ? `around ${b}` : b.endsWith("+") ? `${b.slice(0, -1)} and over` : b.replace("-", "–");
// Percentile of v given [p10,p25,p50,p75,p90] (nulls allowed); linear between known points, ~3/97 beyond the ends
export function percentileOf(v, ps) {
  const pts = [[10, ps[0]], [25, ps[1]], [50, ps[2]], [75, ps[3]], [90, ps[4]]].filter(p => typeof p[1] === "number");
  if (pts.length < 2 || v == null) return null;
  if (v <= pts[0][1]) { const [p, x] = pts[0], [p2, x2] = pts[1]; const slope = (p2 - p) / ((x2 - x) || 1); return Math.max(1, p - (x - v) * slope); }
  for (let i = 1; i < pts.length; i++) if (v <= pts[i][1]) { const [pa, xa] = pts[i - 1], [pb, xb] = pts[i]; return pa + (pb - pa) * (v - xa) / ((xb - xa) || 1); }
  const [p, x] = pts[pts.length - 1], [p0, x0] = pts[pts.length - 2]; const slope = (p - p0) / ((x - x0) || 1); return Math.min(99, p + (v - x) * slope);
}
export const fmtBench = (v, u) => v == null ? "—" : (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : Math.round(v * 10) / 10) + (u === "%" ? "%" : u ? " " + u : "");

export function userValues(days, sections) {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const last = sorted[sorted.length - 1]?.date;
  const cut = (n) => { if (!last) return ""; const d = new Date(last + "T12:00:00"); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
  const c30 = cut(30), c365 = cut(365), out = {};
  for (const m of BENCH_METRICS) {
    if (m.win === "avg") {
      const v = sorted.filter(d => d.date > c30).map(d => m.get(d, sections)).filter(x => x != null);
      if (v.length) out[m.key] = { value: v.reduce((a, b) => a + b, 0) / v.length, n: v.length, note: `30-day average · ${v.length} days` };
    } else {
      for (let i = sorted.length - 1; i >= 0 && sorted[i].date > c365; i--) {
        const v = m.get(sorted[i], sections);
        if (v != null) { out[m.key] = { value: v, note: `latest · ${sorted[i].date}` }; break; }
      }
    }
  }
  return out;
}

// Verdict for one metric: how the user stacks up, in words, plus "% of cohort beaten"
export function verdictFor(m, value, ps, cohort) {
  const pct = percentileOf(value, ps);
  const rank = pct == null ? null : m.dir === "down" ? 100 - pct : pct;
  const tone = m.dir === "neutral" ? "neu" : rank >= 60 ? "good" : rank >= 40 ? "neu" : "bad";
  const text = m.dir === "neutral" ? `You're at the ${Math.round(pct)}th percentile for ${cohort}.`
    : rank >= 60 ? `You're outranking ${Math.round(rank)}% of ${cohort}. Good job!`
    : rank >= 40 ? `You're right on target with ${cohort}.`
    : `Your ${/^[A-Z0-9]{2,}/.test(m.label) ? m.label : m.label.toLowerCase()} is on the ${m.dir === "down" ? "higher" : "lower"} end for ${cohort}.`;
  return { pct, rank, tone, text };
}
// Everything the Benchmarks screen needs (web and iPhone)
export function benchmarkList(days, sections, profile) {
  const age = profile?.birthYear ? new Date().getFullYear() - profile.birthYear : null;
  if (!profile?.sex || !age) return { ready: false, age, items: [], missing: [] };
  const you = userValues(days, sections), sexWord = profile.sex === "female" ? "women" : "men";
  const items = [], missing = [];
  for (const m of BENCH_METRICS) {
    if ((m.sex && m.sex !== profile.sex) || !BENCH_REF[m.key]) continue;
    const ref = BENCH_REF[m.key], bands = Object.keys(ref[profile.sex] || {}), band = ageBand(age, bands), ps = band && ref[profile.sex][band];
    if (!ps || ps.filter(x => x != null).length < 2) continue;
    if (!you[m.key]) { missing.push(m.label); continue; }
    const cohort = `${sexWord} ${bandLabel(band)}`;
    items.push({ key: m.key, label: m.label, unit: m.unit, dir: m.dir, value: you[m.key].value, note: you[m.key].note, band, cohort, ps, source: ref.source, ...verdictFor(m, you[m.key].value, ps, cohort) });
  }
  return { ready: true, age, sexWord, items, missing, sources: [...new Set(items.map(x => x.source))] };
}
