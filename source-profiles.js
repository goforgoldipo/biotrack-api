// ─────────────────────────────────────────────────────────────────
//  Source profiles: known export files → one consistent section layout.
//  When an upload matches a profile, the columns, units and per-day rules below are
//  used directly (no AI guessing), so every user's Hume / Dexcom / LibreView / Strava
//  file lands in the same section with the same KPIs.
//  Column names come from docs/export-formats.md (verified against real exports or
//  published parsers). Values are converted to the board's units (lb, miles, min).
//  Files from the same app share one section name, so e.g. WHOOP cycles + sleeps +
//  workouts merge into a single "WHOOP recovery" section.
//
//  TODO(garmin): Garmin Connect's bulk export is a ZIP of JSON (DI_CONNECT/
//  DI-Connect-Aggregator/UDSFile_*.json, *_sleepData.json, *_summarizedActivities.json),
//  not CSV, so it can't be a CSV profile here. Add a JSON importer later; see the Garmin
//  section of docs/export-formats.md (use currentDayRestingHeartRate, not the 7-day
//  restingHeartRate; skip UNCONFIRMED 5.0 h placeholder nights).
// ─────────────────────────────────────────────────────────────────
const KG = 2.20462;
const M_PER_MI = 1609.34;
const TZ = process.env.USER_TZ || "America/New_York";   // until accounts store each user's time zone

// UTC timestamp → the user's local calendar day
function localDay(t) {
  const d = new Date(t); if (isNaN(d)) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
const num = (v) => { const n = parseFloat(String(v ?? "").replace(/[^0-9.\-]/g, "")); return isFinite(n) ? n : null; };
const has = (headers, ...cols) => cols.every(c => headers.some(h => h.trim() === c));
const hasLike = (headers, re) => headers.some(h => re.test(h.trim()));
const pad = (n) => String(n).padStart(2, "0");

// Wall-clock timestamps written in the user's local time (no zone):
// "2025-01-30 12:34:56 pm" (Strong iOS), "2026-05-09 16:52:30" (WHOOP),
// "30 Jan 2025, 12:34" / "Jan 30, 2025, 12:34 PM" (Hevy).
// Returns { day: "YYYY-MM-DD", min: minutes on a wall-clock scale } — good for durations and ordering.
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function wallTime(s) {
  s = String(s ?? "").trim(); let m, y, mo, d, H = 0, M = 0, S = 0, ap;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]m)?)?/i))) [, y, mo, d, H = 0, M = 0, S = 0, ap] = m;
  else if ((m = s.match(/^(\d{1,2}) ([A-Za-z]{3})[a-z]* (\d{4}),?(?: (\d{1,2}):(\d{2})\s*([ap]m)?)?/i))) { [, d, mo, y, H = 0, M = 0, ap] = m; mo = MON[mo.toLowerCase()]; }
  else if ((m = s.match(/^([A-Za-z]{3})[a-z]* (\d{1,2}),? (\d{4}),?(?: (\d{1,2}):(\d{2})\s*([ap]m)?)?/i))) { [, mo, d, y, H = 0, M = 0, ap] = m; mo = MON[mo.toLowerCase()]; }
  else return null;
  y = +y; mo = +mo; d = +d; H = +H; M = +M; S = +S;
  if (!mo || !d) return null;
  if (ap) { const pm = /pm/i.test(ap); if (pm && H < 12) H += 12; if (!pm && H === 12) H = 0; }
  return { day: `${y}-${pad(mo)}-${pad(d)}`, min: Date.UTC(y, mo - 1, d, H, M, S) / 60000 };
}
const minutesBetween = (a, b) => { const x = wallTime(a), y = wallTime(b); return x && y && y.min >= x.min ? y.min - x.min : null; };
// Strong iOS duration: "49m", "1h 5m", "1h", "45s"
function textDuration(s) {
  s = String(s ?? "").trim(); if (!s) return null;
  const h = s.match(/(\d+(?:\.\d+)?)\s*h/i), m = s.match(/(\d+(?:\.\d+)?)\s*m(?!s)/i), sec = s.match(/(\d+(?:\.\d+)?)\s*s/i);
  if (!h && !m && !sec) return num(s);
  return (h ? +h[1] * 60 : 0) + (m ? +m[1] : 0) + (sec ? +sec[1] / 60 : 0);
}
// Withings writes "(kg)" or "(lb)" in the header depending on the account setting → value in lb
function massLb(prefix) {
  const re = new RegExp(`^${prefix} \\((kg|lbs?)\\)$`, "i");
  return (r) => { const k = Object.keys(r).find(x => re.test(x)); if (!k) return null; const v = num(r[k]); return v == null ? null : /kg/i.test(k) ? v * KG : v; };
}

// agg: last | avg | sum | max | count (rows) | distinct (unique values of col) | sd
//      | inRange:[lo,hi] (% of readings) | below:x (% of readings) | distance (m or km → mi)
//      | once:keyFn (sum the value once per key, e.g. workout duration repeated on every set)
// col: a header name, "@glucose" (profile.col picks it), or a function (row → number; → key for distinct)
const F = (label, unit, col, agg, direction, sameAs = "", mult = 1) => ({ label, unit, col, agg, direction, sameAs, mult });

const isTrue = (v) => /^(1|true|yes)$/i.test(String(v ?? "").trim());

// Hevy writes weight_kg or weight_lbs depending on the unit setting → lb
const hevyLb = (r) => { if ("weight_kg" in r) { const v = num(r.weight_kg); return v == null ? null : v * KG; } return num(r.weight_lbs); };
// Strong (both layouts) and Hevy: one row per set
const strongVolLb = (wcol, toLb) => (r) => { const w = num(r[wcol]), n = num(r.Reps); return w == null || n == null ? null : w * n * toLb; };

const PROFILES = [
  {
    id: "hume_csv", app: "Hume", section: "Hume body scan",
    desc: "Hume Body Pod / scale export (Hume app → export CSV). Every weigh-in; masses converted from kg to lb.",
    match: (h) => has(h, "time", "basalMetabolicRate", "fatRate", "weight", "visceralFat"),
    date: (r) => localDay(r.time), utc: true, time: (r) => Date.parse(r.time),
    fields: [
      F("Weight", "lbs", "weight", "last", "neutral", "weight", KG),
      F("Body fat", "%", "fatRate", "last", "down", "bodyFat"),
      F("Fat mass", "lbs", "fatMass", "last", "down", "fatMass", KG),
      F("Fat-free mass", "lbs", "fatFreeMass", "last", "up", "leanMass", KG),
      F("Muscle mass", "lbs", "muscleMass", "last", "up", "muscleMass", KG),
      F("Muscle rate", "%", "muscleRate", "last", "up"),
      F("Visceral fat", "level", "visceralFat", "last", "down"),
      F("Subcutaneous fat", "%", "subcutaneousFat", "last", "down"),
      F("Body water", "%", "moisture", "last", "up"),
      F("Protein", "%", "proteinRate", "last", "up"),
      F("Bone mass", "lbs", "boneMass", "last", "up", "boneMass", KG),
      F("BMR", "kcal", "basalMetabolicRate", "last", "up", "bmr"),
      F("Metabolic age", "yrs", "physicalAge", "last", "down"),
      F("BMI", "", "bmi", "last", "neutral", "bmi"),
    ],
  },
  {
    id: "dexcom_clarity", app: "Dexcom", section: "Dexcom glucose",
    desc: "Dexcom Clarity export (clarity.dexcom.com → Export). Glucose readings only (EGV rows); Low/High text skipped.",
    match: (h) => h.some(x => /^Glucose Value \(mg\/dL\)/.test(x)) && has(h, "Event Type"),
    keep: (r) => String(r["Event Type"]).trim() === "EGV",
    date: (r) => { const k = Object.keys(r).find(x => /^Timestamp/.test(x)); return String(r[k] || "").slice(0, 10) || null; },   // device local time
    col: (h) => h.find(x => /^Glucose Value \(mg\/dL\)/.test(x)),
    fields: [
      F("Average glucose", "mg/dL", "@glucose", "avg", "down"),
      F("Time in range (70–140)", "%", "@glucose", { inRange: [70, 140] }, "up"),
      F("Time below 70", "%", "@glucose", { below: 70 }, "down"),
      F("Highest glucose", "mg/dL", "@glucose", "max", "down"),
      F("Glucose variability (SD)", "mg/dL", "@glucose", "sd", "down"),
    ],
  },
  {
    id: "libreview", app: "LibreView", section: "Libre glucose",
    desc: "FreeStyle Libre export (LibreView → Glucose History → Download). Historic 15-minute readings.",
    headerLine: /Device Timestamp/,           // a metadata block comes before the header
    match: (h) => has(h, "Device Timestamp", "Record Type") && h.some(x => /^Historic Glucose mg\/dL/.test(x)),
    keep: (r) => String(r["Record Type"]).trim() === "0",
    date: (r) => r["Device Timestamp"],      // device local time, US M-D-Y
    col: (h) => h.find(x => /^Historic Glucose mg\/dL/.test(x)),
    fields: [
      F("Average glucose", "mg/dL", "@glucose", "avg", "down"),
      F("Time in range (70–140)", "%", "@glucose", { inRange: [70, 140] }, "up"),
      F("Time below 70", "%", "@glucose", { below: 70 }, "down"),
      F("Highest glucose", "mg/dL", "@glucose", "max", "down"),
      F("Glucose variability (SD)", "mg/dL", "@glucose", "sd", "down"),
    ],
  },
  {
    id: "strava_activities", app: "Strava", section: "Strava training",
    desc: "Strava bulk export (Settings → My Account → Download your archive) → activities.csv.",
    match: (h) => has(h, "Activity ID", "Activity Date", "Activity Type", "Moving Time"),
    date: (r) => localDay(r["Activity Date"]), utc: true, time: (r) => Date.parse(r["Activity Date"]),
    fields: [
      F("Activities", "", "Activity ID", "count", "up"),
      F("Moving time", "min", "Moving Time", "sum", "up", "", 1 / 60),
      F("Distance", "mi", "Distance", { distance: true }, "up"),
      F("Elevation gain", "ft", "Elevation Gain", "sum", "up", "", 3.28084),
      F("Relative Effort", "", "Relative Effort", "sum", "neutral"),
      F("Calories", "kcal", "Calories", "sum", "up"),
      F("Average heart rate", "bpm", "Average Heart Rate", "avg", "neutral"),
    ],
  },

  // ── Nutrition ──────────────────────────────────────────────────
  {
    id: "cronometer_daily", app: "Cronometer", section: "Cronometer nutrition",
    desc: "Cronometer daily nutrition (cronometer.com → Settings → Export Data → Daily Nutrition) → dailySummary.csv. One row per day.",
    match: (h) => has(h, "Date", "Energy (kcal)", "Protein (g)", "Net Carbs (g)", "Fat (g)") && !has(h, "Food Name"),
    date: (r) => r.Date,
    fields: [
      F("Calories", "kcal", "Energy (kcal)", "sum", "neutral"),
      F("Protein", "g", "Protein (g)", "sum", "up"),
      F("Carbs", "g", "Carbs (g)", "sum", "neutral"),
      F("Net carbs", "g", "Net Carbs (g)", "sum", "neutral"),
      F("Fat", "g", "Fat (g)", "sum", "neutral"),
      F("Saturated fat", "g", "Saturated (g)", "sum", "down"),
      F("Fiber", "g", "Fiber (g)", "sum", "up"),
      F("Sugars", "g", "Sugars (g)", "sum", "down"),
      F("Added sugars", "g", "Added Sugars (g)", "sum", "down"),
      F("Cholesterol", "mg", "Cholesterol (mg)", "sum", "down"),
      F("Caffeine", "mg", "Caffeine (mg)", "sum", "neutral"),
      F("Alcohol", "g", "Alcohol (g)", "sum", "down"),
    ],
  },
  {
    id: "cronometer_biometrics", app: "Cronometer", section: "Cronometer nutrition",
    desc: "Cronometer biometrics (Export Data → Biometrics) → biometrics.csv. Weight entries, converted to lb.",
    match: (h) => has(h, "Day", "Metric", "Unit", "Amount"),
    keep: (r) => /^weight$/i.test(String(r.Metric).trim()),
    date: (r) => r.Day, time: (r) => wallTime(`${r.Day} ${r.Time || ""}`.trim())?.min,
    fields: [
      F("Weight", "lbs", (r) => { const v = num(r.Amount); return v == null ? null : /^kg/i.test(String(r.Unit).trim()) ? v * KG : v; }, "last", "neutral", "weight"),
    ],
  },
  {
    id: "mfp_nutrition", app: "MyFitnessPal", section: "MyFitnessPal nutrition",
    desc: "MyFitnessPal Premium export (myfitnesspal.com/reports/export) → Nutrition-Summary-*.csv. One row per meal; summed per day.",
    match: (h) => has(h, "Date", "Meal", "Calories", "Fat (g)", "Carbohydrates (g)", "Protein (g)", "Sodium (mg)") && !has(h, "Icon"),
    date: (r) => r.Date,
    fields: [
      F("Calories", "kcal", "Calories", "sum", "neutral"),
      F("Protein", "g", "Protein (g)", "sum", "up"),
      F("Carbs", "g", "Carbohydrates (g)", "sum", "neutral"),
      F("Fat", "g", "Fat (g)", "sum", "neutral"),
      F("Saturated fat", "g", "Saturated Fat", "sum", "down"),
      F("Fiber", "g", "Fiber", "sum", "up"),
      F("Sugar", "g", "Sugar", "sum", "down"),
      F("Sodium", "mg", "Sodium (mg)", "sum", "down"),
      F("Cholesterol", "mg", "Cholesterol", "sum", "down"),
    ],
  },
  {
    id: "mfp_exercise", app: "MyFitnessPal", section: "MyFitnessPal nutrition",
    desc: "MyFitnessPal Premium export → Exercise-Summary-*.csv. One row per logged exercise; summed per day.",
    match: (h) => has(h, "Date", "Exercise", "Exercise Calories", "Exercise Minutes"),
    date: (r) => r.Date,
    fields: [
      F("Exercise calories", "kcal", "Exercise Calories", "sum", "up"),
      F("Exercise minutes", "min", "Exercise Minutes", "sum", "up"),
      F("Steps", "", "Steps", "sum", "up"),
    ],
  },
  {
    id: "loseit_food_logs", app: "Lose It!", section: "Lose It! nutrition",
    desc: "Lose It! export (loseit.com → Settings → Export, emailed ZIP) → food-logs.csv. One row per food; deleted entries skipped.",
    match: (h) => has(h, "Date", "Name", "Icon", "Meal", "Calories", "Deleted", "Fat (g)", "Protein (g)"),
    keep: (r) => !isTrue(r.Deleted),
    date: (r) => r.Date,                    // M/D/YYYY
    fields: [
      F("Calories", "kcal", "Calories", "sum", "neutral"),
      F("Protein", "g", "Protein (g)", "sum", "up"),
      F("Carbs", "g", "Carbohydrates (g)", "sum", "neutral"),
      F("Fat", "g", "Fat (g)", "sum", "neutral"),
      F("Saturated fat", "g", "Saturated Fat (g)", "sum", "down"),
      F("Fiber", "g", "Fiber (g)", "sum", "up"),
      F("Sugars", "g", "Sugars (g)", "sum", "down"),
      F("Sodium", "mg", "Sodium (mg)", "sum", "down"),
      F("Cholesterol", "mg", "Cholesterol (mg)", "sum", "down"),
    ],
  },

  // ── Strength / workouts ────────────────────────────────────────
  {
    // iOS layout: comma-delimited, weight in the app's unit (not stated in the file), so no weight KPIs
    id: "strong_ios", app: "Strong", section: "Strong workouts",
    desc: "Strong app export (Settings → Export Data), iOS comma layout. One row per set; warm-up/drop/failure and timer rows skipped. Weight unit isn't in this layout, so volume isn't computed.",
    match: (h) => has(h, "Date", "Workout Name", "Duration", "Exercise Name", "Set Order", "Weight", "Reps"),
    keep: (r) => /^\d+$/.test(String(r["Set Order"]).trim()),
    date: (r) => wallTime(r.Date)?.day,
    fields: [
      F("Workouts", "", (r) => `${r.Date}|${r["Workout Name"]}`, "distinct", "up"),
      F("Workout minutes", "min", (r) => textDuration(r.Duration), { once: (r) => `${r.Date}|${r["Workout Name"]}` }, "up"),
      F("Sets", "", "Set Order", "count", "up"),
      F("Reps", "", "Reps", "sum", "up"),
      F("Average RPE", "", "RPE", "avg", "neutral"),
    ],
  },
  {
    // Android layout: semicolon-delimited, every field quoted, weight in kg (header says so)
    id: "strong_android", app: "Strong", section: "Strong workouts",
    desc: "Strong app export (Settings → Export Data), Android semicolon layout. One row per set; warm-up/drop/failure and timer rows skipped; kg converted to lb.",
    match: (h) => has(h, "Workout #", "Date", "Workout Name", "Duration (sec)", "Exercise Name", "Set Order", "Weight (kg)", "Reps"),
    keep: (r) => /^\d+$/.test(String(r["Set Order"]).trim()),
    date: (r) => wallTime(r.Date)?.day,
    fields: [
      F("Workouts", "", "Workout #", "distinct", "up"),
      F("Workout minutes", "min", "Duration (sec)", { once: (r) => r["Workout #"] }, "up", "", 1 / 60),
      F("Sets", "", "Set Order", "count", "up"),
      F("Reps", "", "Reps", "sum", "up"),
      F("Volume", "lbs", strongVolLb("Weight (kg)", KG), "sum", "up"),
      F("Heaviest set", "lbs", "Weight (kg)", "max", "up", "", KG),
      F("Average RPE", "", "RPE", "avg", "neutral"),
    ],
  },
  {
    id: "hevy_workouts", app: "Hevy", section: "Hevy workouts",
    desc: "Hevy CSV export (Settings → Export data). One row per set; warm-up sets skipped; kg converted to lb.",
    match: (h) => has(h, "title", "start_time", "end_time", "exercise_title", "set_index", "set_type", "reps") && (has(h, "weight_kg") || has(h, "weight_lbs")),
    keep: (r) => String(r.set_type).trim().toLowerCase() !== "warmup",
    date: (r) => wallTime(r.start_time)?.day,
    fields: [
      F("Workouts", "", (r) => `${r.start_time}|${r.title}`, "distinct", "up"),
      F("Workout minutes", "min", (r) => minutesBetween(r.start_time, r.end_time), { once: (r) => `${r.start_time}|${r.title}` }, "up"),
      F("Sets", "", "set_index", "count", "up"),
      F("Reps", "", "reps", "sum", "up"),
      F("Volume", "lbs", (r) => { const w = hevyLb(r), n = num(r.reps); return w == null || n == null ? null : w * n; }, "sum", "up"),
      F("Heaviest set", "lbs", hevyLb, "max", "up"),
      F("Average RPE", "", "rpe", "avg", "neutral"),
    ],
  },
  {
    id: "peloton_workouts", app: "Peloton", section: "Peloton workouts",
    desc: "Peloton workout history (members.onepeloton.com → profile → Workouts → Download Workouts). One row per class.",
    match: (h) => has(h, "Workout Timestamp", "Fitness Discipline", "Length (minutes)", "Total Output", "Calories Burned"),
    date: (r) => r["Workout Timestamp"],    // "2021-03-30 15:15 (-04)": local wall time first
    fields: [
      F("Workouts", "", "Workout Timestamp", "count", "up"),
      F("Workout minutes", "min", "Length (minutes)", "sum", "up"),
      F("Total output", "kJ", "Total Output", "sum", "up"),
      F("Average watts", "W", "Avg. Watts", "avg", "up"),
      F("Calories", "kcal", "Calories Burned", "sum", "up"),
      F("Distance", "mi", "Distance (mi)", "sum", "up"),
      F("Average heart rate", "bpm", "Avg. Heartrate", "avg", "neutral"),
    ],
  },

  // ── WHOOP (cycles are sleep-to-sleep, not calendar days: bucket on the cycle's local start day) ──
  {
    id: "whoop_cycles", app: "WHOOP", section: "WHOOP recovery",
    desc: "WHOOP data export (app → Settings → Data Export, emailed) → physiological_cycles.csv. One row per cycle (sleep to sleep), filed on the day the cycle starts.",
    match: (h) => has(h, "Cycle start time", "Cycle end time", "Recovery score %", "Day Strain"),
    date: (r) => wallTime(r["Cycle start time"])?.day, time: (r) => wallTime(r["Cycle start time"])?.min,
    fields: [
      F("Recovery", "%", "Recovery score %", "last", "up"),
      F("Day strain", "", "Day Strain", "last", "neutral"),
      F("Resting heart rate", "bpm", "Resting heart rate (bpm)", "last", "down", "restingHR"),
      F("HRV", "ms", "Heart rate variability (ms)", "last", "up", "hrv"),
      F("Blood oxygen", "%", "Blood oxygen %", "last", "up", "spo2"),
      F("Calories burned", "kcal", "Energy burned (cal)", "last", "neutral"),
      F("Average heart rate", "bpm", "Average HR (bpm)", "last", "neutral"),
      F("Sleep performance", "%", "Sleep performance %", "last", "up"),
      F("Respiratory rate", "brpm", "Respiratory rate (rpm)", "last", "neutral", "respiratoryRate"),
      F("Asleep", "hrs", "Asleep duration (min)", "last", "up", "", 1 / 60),
      F("Deep sleep", "min", "Deep (SWS) duration (min)", "last", "up"),
      F("REM sleep", "min", "REM duration (min)", "last", "up"),
      F("Sleep efficiency", "%", "Sleep efficiency %", "last", "up"),
      F("Sleep consistency", "%", "Sleep consistency %", "last", "up"),
      F("Sleep debt", "min", "Sleep debt (min)", "last", "down"),
    ],
  },
  {
    id: "whoop_sleeps", app: "WHOOP", section: "WHOOP recovery",
    desc: "WHOOP data export → sleeps.csv. Main sleep only (naps skipped), filed on the day its cycle starts.",
    match: (h) => has(h, "Cycle start time", "Sleep onset", "Wake onset", "Asleep duration (min)", "Nap") && !has(h, "Recovery score %"),
    keep: (r) => !isTrue(r.Nap),
    date: (r) => wallTime(r["Cycle start time"])?.day, time: (r) => wallTime(r["Sleep onset"])?.min,
    fields: [
      F("Sleep performance", "%", "Sleep performance %", "last", "up"),
      F("Respiratory rate", "brpm", "Respiratory rate (rpm)", "last", "neutral", "respiratoryRate"),
      F("Asleep", "hrs", "Asleep duration (min)", "last", "up", "", 1 / 60),
      F("Deep sleep", "min", "Deep (SWS) duration (min)", "last", "up"),
      F("REM sleep", "min", "REM duration (min)", "last", "up"),
      F("Sleep efficiency", "%", "Sleep efficiency %", "last", "up"),
      F("Sleep consistency", "%", "Sleep consistency %", "last", "up"),
      F("Sleep debt", "min", "Sleep debt (min)", "last", "down"),
    ],
  },
  {
    id: "whoop_workouts", app: "WHOOP", section: "WHOOP recovery",
    desc: "WHOOP data export → workouts.csv. One row per workout, filed on the workout's local start day.",
    match: (h) => has(h, "Cycle start time", "Workout start time", "Workout end time", "Activity name", "Activity Strain"),
    date: (r) => wallTime(r["Workout start time"])?.day,
    fields: [
      F("Workouts", "", "Workout start time", "count", "up"),
      F("Workout minutes", "min", (r) => minutesBetween(r["Workout start time"], r["Workout end time"]), "sum", "up"),
      F("Top workout strain", "", "Activity Strain", "max", "neutral"),
      F("Workout calories", "kcal", "Energy burned (cal)", "sum", "up"),
      F("Workout distance", "mi", "Distance (meters)", "sum", "up", "", 1 / M_PER_MI),
      F("Workout heart rate", "bpm", "Average HR (bpm)", "avg", "neutral"),
    ],
  },

  // ── Withings ───────────────────────────────────────────────────
  {
    id: "withings_weight", app: "Withings", section: "Withings measurements",
    desc: "Withings export (Health Mate → Settings → Export all health data / web Download my data) → weight.csv. Last weigh-in per day; kg converted to lb.",
    match: (h) => has(h, "Date", "Comments") && hasLike(h, /^Weight \((kg|lbs?)\)$/i) && hasLike(h, /^Fat mass \((kg|lbs?)\)$/i),
    date: (r) => r.Date, time: (r) => wallTime(r.Date)?.min,   // local wall time
    fields: [
      F("Weight", "lbs", massLb("Weight"), "last", "neutral", "weight"),
      F("Body fat", "%", (r) => { const f = massLb("Fat mass")(r), w = massLb("Weight")(r); return f == null || !w ? null : f / w * 100; }, "last", "down", "bodyFat"),
      F("Fat mass", "lbs", massLb("Fat mass"), "last", "down", "fatMass"),
      F("Muscle mass", "lbs", massLb("Muscle mass"), "last", "up", "muscleMass"),
      F("Bone mass", "lbs", massLb("Bone mass"), "last", "up", "boneMass"),
      F("Body water", "lbs", massLb("Hydration"), "last", "up"),
    ],
  },
  {
    id: "withings_bp", app: "Withings", section: "Withings measurements",
    desc: "Withings export → bp.csv. Blood-pressure readings averaged per day.",
    match: (h) => has(h, "Date", "Heart Rate", "Systolic", "Diastolic", "Comments"),
    date: (r) => r.Date,
    fields: [
      F("Systolic BP", "mmHg", "Systolic", "avg", "down", "bloodPressureSystolic"),
      F("Diastolic BP", "mmHg", "Diastolic", "avg", "down", "bloodPressureDiastolic"),
      F("Pulse", "bpm", "Heart Rate", "avg", "down"),
    ],
  },
];

// Cut a metadata preamble so the header is the first line
function trimPreamble(text, profile) {
  if (!profile?.headerLine) return text;
  const lines = String(text).split(/\r?\n/); const i = lines.findIndex(l => profile.headerLine.test(l));
  return i > 0 ? lines.slice(i).join("\n") : text;
}

// Semicolon-delimited CSV (Strong Android, European exports) → comma CSV the shared parser reads.
// Sniffs the header line: more unquoted ";" than "," means semicolons. Decimal commas ("72,5") become dots.
function normalizeDelimiter(text) {
  text = String(text ?? "");
  const first = text.split(/\r?\n/).find(l => l.trim() !== "") || "";
  let semi = 0, comma = 0, q = false;
  for (const ch of first) { if (ch === '"') q = !q; else if (!q && ch === ";") semi++; else if (!q && ch === ",") comma++; }
  if (semi <= comma) return text;
  const out = []; let row = [], cur = "", inQ = false;
  const endField = () => { row.push(/^-?\d+,\d+$/.test(cur.trim()) ? cur.trim().replace(",", ".") : cur); cur = ""; };
  const endRow = () => { endField(); out.push(row.map(f => `"${f.replace(/"/g, '""')}"`).join(",")); row = []; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += ch; }
    else if (ch === '"') inQ = true;
    else if (ch === ";") endField();
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; endRow(); }
    else cur += ch;
  }
  if (cur !== "" || row.length) endRow();
  return out.join("\n");
}
const prepare = (text, profile) => normalizeDelimiter(trimPreamble(text, profile));
const headersFor = (text, profile, parseCSVText) => parseCSVText(prepare(String(text).split(/\r?\n/).slice(0, 40).join("\n"), profile).split(/\r?\n/).slice(0, 3).join("\n")).headers.map(h => h.trim());

// Every profile that fits this file (each tried with its own preamble rule)
function matchAll(text, parseCSVText) {
  return PROFILES.filter(p => { const h = headersFor(text, p, parseCSVText); return h.length && p.match(h); });
}
// Which profile fits this file
function detect(text, parseCSVText) {
  return matchAll(text, parseCSVText)[0] || null;
}

// File → [{date, values: {label: value}}] using the profile's rules.
// If the section's stored profile doesn't fit this file but a sibling profile of the same
// section does (e.g. sleeps.csv uploaded into a section created from WHOOP cycles), use that one.
function rows(profile, text, parseCSVText, isoDay) {
  if (!profile.match(headersFor(text, profile, parseCSVText))) {
    const alt = matchAll(text, parseCSVText).find(p => p.section === profile.section);
    if (alt) profile = alt;
  }
  const { headers, records } = parseCSVText(prepare(text, profile));
  const gcol = profile.col?.(headers.map(h => h.trim()));
  const perDay = {};
  for (const r0 of records) {
    const r = Object.fromEntries(Object.entries(r0).map(([k, v]) => [k.trim(), typeof v === "string" ? v.trim() : v]));
    if (profile.keep && !profile.keep(r)) continue;
    const date = isoDay(profile.date(r)); if (!date) continue;
    (perDay[date] ||= []).push(r);
  }
  const out = [];
  for (const [date, rs] of Object.entries(perDay)) {
    const values = {};
    for (const f of profile.fields) {
      const a = f.agg;
      if (a === "count") { values[f.label] = rs.length; continue; }
      if (a === "distinct") { values[f.label] = new Set(rs.map(r => typeof f.col === "function" ? f.col(r) : r[f.col]).filter(k => k != null && String(k).trim() !== "")).size; continue; }
      const get = getter(f, gcol);
      const vals = rs.map(get).filter(v => v != null);
      if (!vals.length) continue;
      const n = vals.length, mean = vals.reduce((x, y) => x + y, 0) / n;
      let v;
      if (a === "last") v = profile.time ? latestOf(rs, get, profile) : vals[vals.length - 1];
      else if (a === "avg") v = mean;
      else if (a === "sum") v = vals.reduce((x, y) => x + y, 0);
      else if (a === "max") v = Math.max(...vals);
      else if (a === "sd") v = n > 1 ? Math.sqrt(vals.reduce((x, y) => x + (y - mean) ** 2, 0) / (n - 1)) : null;
      else if (a.inRange) v = vals.filter(x => x >= a.inRange[0] && x <= a.inRange[1]).length / n * 100;
      else if (a.below != null) v = vals.filter(x => x < a.below).length / n * 100;
      else if (a.distance) v = vals.reduce((x, y) => x + (y > 1000 ? y / M_PER_MI : y / 1.60934), 0);   // raw metres, or km
      else if (a.once) { const seen = new Set(); v = 0; for (const r of rs) { const k = a.once(r), x = get(r); if (x == null || seen.has(k)) continue; seen.add(k); v += x; } }
      if (v != null && isFinite(v)) values[f.label] = v * (f.mult || 1);
    }
    out.push({ date, values });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
// Row → number for one field
function getter(f, gcol) {
  if (typeof f.col === "function") return (r) => { const v = f.col(r); return v == null || !isFinite(v) ? null : v; };
  if (f.col === "@glucose") {
    // CGM exports write Low/High (or localized Niedrig/Hoch) outside the sensor range: count them at the edge
    return (r) => { const s = String(r[gcol] ?? "").trim(); return /^(low|niedrig|bas)$/i.test(s) ? 39 : /^(high|hoch|haut)$/i.test(s) ? 401 : num(s); };
  }
  return (r) => num(r[f.col]);
}
// Latest reading of the day for timestamped exports (Hume lists newest first)
function latestOf(rs, get, profile) {
  const best = rs.filter(r => get(r) != null).map((r, i) => ({ r, i, t: profile.time(r) }))
    .sort((a, b) => ((isFinite(a.t) ? a.t : -Infinity) - (isFinite(b.t) ? b.t : -Infinity)) || a.i - b.i).pop();
  return best ? get(best.r) : null;
}

// The section a profile creates (KPIs in the board's units, linked to Apple Health measures)
const kpiAggregate = (a) => a === "sum" || a === "avg" || a === "last" ? a : a === "count" || a === "distinct" || a?.once || a?.distance ? "sum" : "avg";
const sectionDef = (p) => ({
  name: p.section, description: p.desc,
  source: { type: "manual", app: p.app, export_instructions: p.desc, profile: p.id },
  kpis: p.fields.map(f => ({ label: f.label, unit: f.unit, aggregate: kpiAggregate(f.agg), direction: f.direction, existing_key: "", sameAs: f.sameAs })),
});

module.exports = { PROFILES, detect, matchAll, rows, sectionDef, trimPreamble, normalizeDelimiter, localDay };
