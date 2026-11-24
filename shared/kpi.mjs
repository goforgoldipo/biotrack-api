// ─────────────────────────────────────────────────────────────────
//  BodyData shared KPI engine — the single source of truth for metric definitions,
//  data mapping, date ranges and KPI calculations. Imported by the web app (React)
//  and by the API (which serves ready-made KPI boards to the native iPhone app).
//  Pure JS: no React, no DOM. Edit here, then run `npm run sync-shared` in biotrack-api.
// ─────────────────────────────────────────────────────────────────
export const GROUPS = [
  { id:"body", name:"BODY COMPOSITION", src:"SCALE & SCANS", col:"#ff6b35", rows:[
    {k:"weight",l:"Weight",u:"lbs",hi:true,lib:true},{k:"bodyFat",l:"Body Fat %",u:"%",hi:true,fat:true},
    {k:"leanMass",l:"Lean Mass",u:"lbs"},{k:"muscleMass",l:"Muscle Mass",u:"lbs",hi:true},
    {k:"muscleRate",l:"Muscle Rate",u:"%"},{k:"fatMass",l:"Fat Mass",u:"lbs",fat:true},
    {k:"bmi",l:"BMI",u:"",lib:true},{k:"visceralFat",l:"Visceral Fat",u:"",fat:true},
    {k:"subcutaneousFat",l:"Subcutaneous Fat",u:"",fat:true},
    {k:"boneMass",l:"Bone Mass",u:"lbs"},
    {k:"proteinMass",l:"Protein Mass",u:"lbs"},{k:"proteinRate",l:"Protein Rate",u:"%"},
    {k:"moisture",l:"Body Water",u:"%"},
    {k:"bmr",l:"BMR",u:"kcal"},{k:"rmr",l:"RMR (measured)",u:"kcal"},{k:"metabolicAge",l:"Metabolic Age",u:"yrs",lib:true},
  ]},
  { id:"segmental", name:"SEGMENTAL BODY FAT", src:"BODY SCAN", col:"#00e5ff", rows:[
    {k:"trunkFat",   l:"Trunk",     u:"%", hi:true, fat:true},
    {k:"rightArmFat",l:"Right Arm", u:"%", fat:true},
    {k:"leftArmFat", l:"Left Arm",  u:"%", fat:true},
    {k:"rightLegFat",l:"Right Leg", u:"%", fat:true},
    {k:"leftLegFat", l:"Left Leg",  u:"%", fat:true},
    {k:"trunkMuscle",    l:"Trunk Muscle",    u:"lbs"},
    {k:"rightArmMuscle", l:"Right Arm Muscle",u:"lbs"},
    {k:"leftArmMuscle",  l:"Left Arm Muscle", u:"lbs"},
    {k:"rightLegMuscle", l:"Right Leg Muscle",u:"lbs"},
    {k:"leftLegMuscle",  l:"Left Leg Muscle", u:"lbs"},
  ]},
  { id:"sleep", name:"SLEEP & RECOVERY", src:"SLEEP TRACKER", col:"#a78bfa", rows:[
    {k:"sleepScore",l:"Sleep Score",u:"/100",hi:true},{k:"sleepDur",l:"Duration",u:"hrs"},
    {k:"deepSleep",l:"Deep Sleep",u:"hrs"},{k:"remSleep",l:"REM Sleep",u:"hrs"},
    {k:"lightSleep",l:"Light Sleep",u:"hrs"},
    {k:"hrv",l:"HRV",u:"ms",hi:true},{k:"restingHR",l:"Resting HR",u:"bpm",lib:true},
    {k:"hrRecovery",l:"HR Recovery 1min",u:"bpm"},{k:"respiratoryRate",l:"Respiratory Rate",u:"/min",lib:true},
    {k:"spo2",l:"SpO2",u:"%"},{k:"sleepingWristTemp",l:"Wrist Temp",u:"°C",neu:true},
    {k:"readiness",l:"Readiness",u:"/100"},
  ]},
  { id:"nutrition", name:"NUTRITION", src:"FOOD LOG", col:"#34d399", rows:[
    {k:"calories",l:"Calories In",u:"kcal",hi:true,neu:true},{k:"protein",l:"Protein",u:"g",hi:true},
    {k:"carbs",l:"Carbs",u:"g",neu:true},{k:"fat",l:"Fat",u:"g",neu:true},{k:"saturatedFat",l:"Saturated Fat",u:"g",lib:true},
    {k:"sugar",l:"Sugar",u:"g",lib:true},{k:"fiber",l:"Fiber",u:"g"},{k:"cholesterol",l:"Cholesterol",u:"mg",lib:true},
    {k:"sodium",l:"Sodium",u:"mg",lib:true},{k:"potassium",l:"Potassium",u:"mg"},
    {k:"calcium",l:"Calcium",u:"mg"},{k:"iron",l:"Iron",u:"mg"},{k:"vitaminC",l:"Vitamin C",u:"mg"},
    {k:"water",l:"Water",u:"L"},
  ]},
  { id:"mealTiming", name:"MEAL TIMING", src:"MANUAL", col:"#34d399", rows:[
    {k:"breakfastTime", l:"Breakfast",      u:"", type:"time", hi:true},
    {k:"lunchTime",     l:"Lunch",          u:"", type:"time"},
    {k:"dinnerTime",    l:"Dinner",         u:"", type:"time"},
    {k:"lastMealTime",  l:"Last Meal",      u:"", type:"time", hi:true},
    {k:"breakfastCals", l:"Breakfast Cals", u:"kcal",neu:true},
    {k:"lunchCals",     l:"Lunch Cals",     u:"kcal",neu:true},
    {k:"dinnerCals",    l:"Dinner Cals",    u:"kcal",neu:true},
    {k:"snackCals",     l:"Snack Cals",     u:"kcal",neu:true},
  ]},
  { id:"activity", name:"ACTIVITY", src:"APPLE HEALTH", col:"#f43f5e", rows:[
    {k:"steps",l:"Steps",u:"",hi:true},{k:"calsBurned",l:"Cals Burned",u:"kcal"},
    {k:"activeMins",l:"Active Mins",u:"min"},{k:"avgHR",l:"Avg Heart Rate",u:"bpm",neu:true},
    {k:"standHours",l:"Stand Hours",u:"hrs"},{k:"flightsClimbed",l:"Flights Climbed",u:""},
    {k:"vo2max",l:"VO2 Max",u:""},{k:"walkingSteadiness",l:"Walking Steadiness",u:"%"},
  ]},
  { id:"training", name:"TRAINING", src:"WORKOUT LOG", col:"#fbbf24", rows:[
    {k:"workoutType",l:"Workout Type",u:"",hi:true},{k:"fitbodMuscleGroups",l:"Muscle Groups",u:""},
    {k:"workoutVol",l:"Total Volume",u:"lbs",hi:true},{k:"workoutDur",l:"Duration",u:"min"},
    {k:"fitbodSets",l:"Total Sets",u:""},{k:"fitbodWorkingSets",l:"Working Sets",u:""},
    {k:"fitbodTotalReps",l:"Total Reps",u:""},{k:"fitbodExerciseCount",l:"Exercises",u:""},
    {k:"fitbodMaxWeightLbs",l:"Max Weight",u:"lbs",hi:true},
  ]},
  { id:"measurements", name:"BODY MEASUREMENTS", src:"MANUAL", col:"#00e5ff", rows:[
    {k:"waistIn",    l:"Waist",        u:"in", hi:true, lib:true},
    {k:"chestIn",    l:"Chest",        u:"in", hi:true},
    {k:"hipsIn",     l:"Hips",         u:"in", lib:true},
    {k:"neckIn",     l:"Neck",         u:"in",neu:true},
    {k:"shouldersIn",l:"Shoulders",    u:"in"},
    {k:"rightBicepIn",l:"Right Bicep", u:"in", hi:true},
    {k:"leftBicepIn", l:"Left Bicep",  u:"in"},
    {k:"rightForearmIn",l:"Right Forearm",u:"in"},
    {k:"leftForearmIn", l:"Left Forearm", u:"in"},
    {k:"rightThighIn",l:"Right Thigh", u:"in", hi:true},
    {k:"leftThighIn", l:"Left Thigh",  u:"in"},
    {k:"rightCalfIn", l:"Right Calf",  u:"in"},
    {k:"leftCalfIn",  l:"Left Calf",   u:"in"},
  ]},
  { id:"volByGroup", name:"VOLUME BY MUSCLE GROUP", src:"WORKOUT LOG", col:"#fbbf24", rows:[
    {k:"volChest",l:"Chest Vol",u:"lbs",hi:true},{k:"repsChest",l:"Chest Reps",u:""},{k:"setsChest",l:"Chest Sets",u:""},{k:"maxChest",l:"Chest Max",u:"lbs"},
    {k:"volBack",l:"Back Vol",u:"lbs",hi:true},{k:"repsBack",l:"Back Reps",u:""},{k:"setsBack",l:"Back Sets",u:""},{k:"maxBack",l:"Back Max",u:"lbs"},
    {k:"volShoulders",l:"Shoulders Vol",u:"lbs",hi:true},{k:"repsShoulders",l:"Shoulders Reps",u:""},{k:"setsShoulders",l:"Shoulders Sets",u:""},{k:"maxShoulders",l:"Shoulders Max",u:"lbs"},
    {k:"volBiceps",l:"Biceps Vol",u:"lbs",hi:true},{k:"repsBiceps",l:"Biceps Reps",u:""},{k:"setsBiceps",l:"Biceps Sets",u:""},{k:"maxBiceps",l:"Biceps Max",u:"lbs"},
    {k:"volTriceps",l:"Triceps Vol",u:"lbs",hi:true},{k:"repsTriceps",l:"Triceps Reps",u:""},{k:"setsTriceps",l:"Triceps Sets",u:""},{k:"maxTriceps",l:"Triceps Max",u:"lbs"},
    {k:"volLegs",l:"Legs Vol",u:"lbs",hi:true},{k:"repsLegs",l:"Legs Reps",u:""},{k:"setsLegs",l:"Legs Sets",u:""},{k:"maxLegs",l:"Legs Max",u:"lbs"},
    {k:"volCore",l:"Core Vol",u:"lbs",hi:true},{k:"repsCore",l:"Core Reps",u:""},{k:"setsCore",l:"Core Sets",u:""},{k:"maxCore",l:"Core Max",u:"lbs"},
    {k:"trunkFat",l:"Trunk Fat",u:"%",fat:true},{k:"rightArmFat",l:"Right Arm Fat",u:"%",fat:true},
    {k:"leftArmFat",l:"Left Arm Fat",u:"%",fat:true},{k:"rightLegFat",l:"Right Leg Fat",u:"%",fat:true},
    {k:"leftLegFat",l:"Left Leg Fat",u:"%",fat:true},
  ]},
];

export const parseSyncDateRobust = (s, anchor) => {
  if (!s) return null;
  // ISO format: parse as local time to avoid UTC-offset off-by-one
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const [y, m, d] = s.slice(0, 10).split("-").map(Number);
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    return new Date(y, m - 1, d);
  }
  // "Mon Day Year" or "Mon Day, Year" — add comma before year if missing (Safari fix)
  const normed = s.replace(/^([A-Za-z]+\s+\d{1,2})\s+(\d{4})/, "$1, $2");
  const hasYear = /\b\d{4}\b/.test(normed);
  const withYear = hasYear ? normed : normed + ", " + new Date().getFullYear();
  const p2 = new Date(withYear);
  if (isNaN(p2.getTime())) return null;
  // No year in the original string: health data can't be from the future, so if the
  // inferred date is more than 1 day ahead of today, attribute it to the previous year.
  // (1-day buffer absorbs end-of-day timezone skew for today's syncs.)
  // Note: same-calendar-month dates from the previous year (e.g. "Jun 3" when today is
  // Jun 14) are inherently ambiguous without a year — store dates with year to avoid this.
  // A record can't describe a day after it was received, so anchor yearless dates to the import time.
  const limit = anchor && !isNaN(anchor.getTime()) ? anchor.getTime() : Date.now();
  if (!hasYear) while (p2 > new Date(limit + 86400000)) p2.setFullYear(p2.getFullYear() - 1);
  return p2;
};

// Point-in-time metrics → the iPhone's same-day aggregate (see mapImport)
const HK_DAILY = { hrv: "hk_heartRateVariabilitySDNN", restingHR: "hk_restingHeartRate", hrRecovery: "hk_heartRateRecoveryOneMinute",
  spo2: "hk_oxygenSaturation", respiratoryRate: "hk_respiratoryRate" };
export const mapImport = (p) => {
  // Derive dow/date — prefer syncDate (actual data date) over _receivedAt (import time)
  // syncDate can be "Apr 12 2026" (with year, no comma) or "Apr 12" (no year)
  let refDate;
  if (p.syncDate) {
    refDate = parseSyncDateRobust(p.syncDate, p._receivedAt ? new Date(p._receivedAt) : null);
  }
  if (!refDate || isNaN(refDate.getTime())) {
    refDate = p._receivedAt ? new Date(p._receivedAt) : new Date();
  }
  const _fmtDateWithYear = (d) => {
    const MO = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return `${MO[d.getMonth()]} ${d.getDate()} ${d.getFullYear()}`;
  };
  const m = {
    syncDate: p.syncDate || _fmtDateWithYear(refDate),
    syncTime: p.syncTime||new Date().toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"}),
    dow: p.dow||["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][refDate.getDay()],
    date: p.date || _fmtDateWithYear(refDate),
    ymd: ymdOf(refDate),
    steps: p.steps||p.stepCount, calsBurned: p.activeCalories||p.calsBurned||p.totalCaloriesBurned,
    restingHR: p.restingHR||p.restingHeartRate, avgHR: p.avgHR||p.averageHeartRate||p.heartRate,
    vo2max: p.vo2max||p.vo2Max, standHours: p.standHours,
    weight: p.weight||p.bodyWeight, bodyFat: p.bodyFat||p.bodyFatPercentage,
    leanMass: p.leanMass||p.leanBodyMass, bmi: p.bmi, visceralFat: p.visceralFat,
    muscleMass: p.muscleMass, muscleRate: p.muscleRate, fatMass: p.fatMass,
    subcutaneousFat: p.subcutaneousFat, boneMass: p.boneMass,
    proteinMass: p.proteinMass, proteinRate: p.proteinRate, moisture: p.moisture,
    bmr: p.bmr||p.basalMetabolicRate||p.basalCalories, rmr: p.rmr||p.restingMetabolicRate, metabolicAge: p.metabolicAge||p.metabolic_age,
    calories: p.calories||p.dietaryCalories, protein: p.protein,
    carbs: p.carbs||p.carbohydrates, fat: p.fat, fiber: p.fiber, water: p.water,
    // Sleep stages in hours everywhere (older imports sent minutes as *Min fields)
    sleepDur: p.sleepDur||p.sleepDuration, deepSleep: p.deepSleep||(p.sleepDeepMin!=null?Math.round(p.sleepDeepMin/6)/10:undefined), remSleep: p.remSleep||(p.sleepREMMin!=null?Math.round(p.sleepREMMin/6)/10:undefined),
    lightSleep: p.lightSleep||(p.sleepCoreMin!=null?Math.round(p.sleepCoreMin/6)/10:undefined), spo2: p.spo2, sleepingWristTemp: p.sleepingWristTemp,
    distanceMiles: p.distanceMiles||(p.distanceKm ? +((p.distanceKm)/1.60934).toFixed(2) : null),
    hrRecovery: p.hrRecovery, walkingSteadiness: p.walkingSteadiness,
    respiratoryRate: p.respiratoryRate, flightsClimbed: p.flightsClimbed||p.flights,
    sugar: p.sugar, cholesterol: p.cholesterol, saturatedFat: p.saturatedFat,
    potassium: p.potassium, calcium: p.calcium, iron: p.iron, vitaminC: p.vitaminC,
    sodium: p.sodium,
    sleepScore: p.sleepScore, hrv: p.hrv, readiness: p.readiness,
    workoutType: (p.workoutType||"").replace("Traditional Strength Training","Strength").replace("High Intensity Interval Training","HIIT").replace("Functional Strength Training","Functional"), workoutDur: p.workoutDur||p.workoutDuration,
    workoutVol: p.workoutVol||p.workoutCalories, exercises: p.exercises||p.fitbodExercises,
    fitbodSets: p.fitbodSets, fitbodWorkingSets: p.fitbodWorkingSets, fitbodWarmupSets: p.fitbodWarmupSets,
    fitbodTotalReps: p.fitbodTotalReps, fitbodExerciseCount: p.fitbodExerciseCount,
    fitbodMaxWeightLbs: p.fitbodMaxWeightLbs, fitbodMuscleGroups: p.fitbodMuscleGroups,
    // Per-muscle-group volume, reps, sets, max
    volChest: p.volChest, volBack: p.volBack, volShoulders: p.volShoulders,
    volBiceps: p.volBiceps, volTriceps: p.volTriceps, volLegs: p.volLegs, volCore: p.volCore,
    repsChest: p.repsChest, repsBack: p.repsBack, repsShoulders: p.repsShoulders,
    repsBiceps: p.repsBiceps, repsTriceps: p.repsTriceps, repsLegs: p.repsLegs, repsCore: p.repsCore,
    setsChest: p.setsChest, setsBack: p.setsBack, setsShoulders: p.setsShoulders,
    setsBiceps: p.setsBiceps, setsTriceps: p.setsTriceps, setsLegs: p.setsLegs, setsCore: p.setsCore,
    maxChest: p.maxChest, maxBack: p.maxBack, maxShoulders: p.maxShoulders,
    maxBiceps: p.maxBiceps, maxTriceps: p.maxTriceps, maxLegs: p.maxLegs, maxCore: p.maxCore,
    // Body measurements (inches) — manually entered
    waistIn:     p.waistIn     || p.waist,
    chestIn:     p.chestIn     || p.chest,
    hipsIn:      p.hipsIn      || p.hips,
    neckIn:      p.neckIn      || p.neck,
    shouldersIn: p.shouldersIn || p.shoulders,
    rightBicepIn:  p.rightBicepIn  || p.rightBicep,
    leftBicepIn:   p.leftBicepIn   || p.leftBicep,
    rightForearmIn:p.rightForearmIn|| p.rightForearm,
    leftForearmIn: p.leftForearmIn || p.leftForearm,
    rightThighIn:  p.rightThighIn  || p.rightThigh,
    leftThighIn:   p.leftThighIn   || p.leftThigh,
    rightCalfIn:   p.rightCalfIn   || p.rightCalf,
    leftCalfIn:    p.leftCalfIn    || p.leftCalf,
    // Hume segmental — accept multiple naming conventions
    trunkFat:    p.trunkFat    || p.trunk_fat    || p.torsoFat  || p.torso_fat,
    rightArmFat: p.rightArmFat || p.right_arm_fat|| p.rightArm,
    leftArmFat:  p.leftArmFat  || p.left_arm_fat || p.leftArm,
    rightLegFat: p.rightLegFat || p.right_leg_fat|| p.rightLeg,
    leftLegFat:  p.leftLegFat  || p.left_leg_fat || p.leftLeg,
    trunkMuscle:    p.trunkMuscle    || p.trunk_muscle,
    rightArmMuscle: p.rightArmMuscle || p.right_arm_muscle,
    leftArmMuscle:  p.leftArmMuscle  || p.left_arm_muscle,
    rightLegMuscle: p.rightLegMuscle || p.right_leg_muscle,
    leftLegMuscle:  p.leftLegMuscle  || p.left_leg_muscle,
    // Meal timing (manually logged or from iOS Shortcut)
    breakfastTime: p.breakfastTime || null,
    lunchTime:     p.lunchTime     || null,
    dinnerTime:    p.dinnerTime    || null,
    lastMealTime:  p.lastMealTime  || null,
    breakfastCals: p.breakfastCals || null,
    lunchCals:     p.lunchCals     || null,
    dinnerCals:    p.dinnerCals    || null,
    snackCals:     p.snackCals     || null,
  };
  // Compute leanMass from weight and bodyFat if not provided
  if(!m.leanMass && m.weight && m.bodyFat) m.leanMass = +(m.weight * (1 - m.bodyFat/100)).toFixed(1);
  if(!m.fatMass && m.weight && m.bodyFat) m.fatMass = +(m.weight * m.bodyFat/100).toFixed(1);
  // Apple exercise minutes are the real "active minutes"; workout duration is only a fallback
  if(!m.activeMins && typeof p.exerciseMinutes === "number") m.activeMins = p.exerciseMinutes;
  if(!m.activeMins && m.workoutDur) m.activeMins = Math.round(m.workoutDur);
  // iPhone days (hkMeta present) carry each metric's daily aggregate as hk_*. The plain fields for
  // these metrics are "latest reading ever", which repeats a stale value on days without a reading
  // and is a single noisy sample on days with one. Use the day's own aggregate, or nothing.
  if (p.hkMeta && typeof p.hkMeta === "object") {
    for (const [k, hk] of Object.entries(HK_DAILY)) {
      const v = p[hk];
      m[k] = typeof v === "number" && isFinite(v) ? v : undefined;
    }
  }
  // Custom metrics uploaded from Manual Entry (c_* keys + their label/unit definitions)
  for (const k in p) if (k.startsWith("c_") && typeof p[k] === "number") m[k] = p[k];
  if (p.customDefs && typeof p.customDefs === "object") m.customDefs = p.customDefs;
  // Every Apple Health type from the iPhone app (hk_ quantities, hkc_ categories, hkw_ workouts)
  for (const k in p) if (/^hk[cw]?_/.test(k) && typeof p[k] === "number")
    m[k] = p[k];   // already a percent: the iPhone app converts HealthKit fractions (0.18 → 18) before sending. Don't rescale small values — a real 0.7 % walking asymmetry would become 70 %.
  if (p.hkMeta && typeof p.hkMeta === "object") m.hkMeta = p.hkMeta;
  if (p.hkSources && typeof p.hkSources === "object") m.hkSources = p.hkSources;
  if (p.source) m.src = p.source;
  if (p._receivedAt) m._rx = p._receivedAt;
  Object.keys(m).forEach(k=>{ if(m[k]===null||m[k]===undefined) delete m[k]; });
  return m;
};

// ─── DATE RANGE (same presets and comparisons as sellmore.me/crm) ──────────────
export const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
export const ymdOf = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
export const todayYmd = () => ymdOf(new Date());
export const addDay = (s, n) => { const d = new Date(s + "T12:00:00"); d.setDate(d.getDate() + n); return ymdOf(d); };
export const mStart = (s, n) => ymdOf(new Date(+s.slice(0,4), +s.slice(5,7) - 1 + (n || 0), 1));
export const mEnd = s => ymdOf(new Date(+s.slice(0,4), +s.slice(5,7), 0));
export const shiftM = (s, n) => { const m = mStart(s, n), e = mEnd(m); const day = m.slice(0,8) + s.slice(8); return day > e ? e : day; };
export const daysIncl = (a, b) => Math.round((new Date(b + "T12:00:00") - new Date(a + "T12:00:00")) / 864e5) + 1;
export const dayList = (a, b) => { const out = []; if (!a || !b || a > b) return out; const d = new Date(a + "T12:00:00"); for (let s = a; s <= b;) { out.push(s); d.setDate(d.getDate() + 1); s = ymdOf(d); } return out; };
export const shortDay = s => s ? MON[+s.slice(5,7) - 1] + " " + (+s.slice(8)) : "";
export function fmtDate(d) {
  if (!d) return '';
  const dt = typeof d === 'string' ? new Date(d+'T00:00:00') : d;
  return dt.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
}
export const DK_PRESETS = [['today','Today'],['yesterday','Yesterday'],['thisweek','This week'],['lastweek','Last week'],['l30','Last 30 days'],['thismonth','This month'],['lastmonth','Last month'],['l90','Last 90 days'],['thisq','This quarter'],['lastq','Last quarter'],['l3m','Last 3 months'],['l6m','Last 6 months'],['l12m','Trailing 12 months'],['thisyear','This year'],['lastyear','Last year']];
export function dkRange(R) {
  const T = todayYmd(), mon = addDay(T, -((new Date(T + "T12:00:00").getDay() + 6) % 7)), q1 = mStart(T, -((+T.slice(5,7) - 1) % 3)), y1 = T.slice(0,4) + "-01-01";
  let a, b, ca, cb, lbl;
  switch (R.p) {
    case "today": a = b = T; ca = cb = addDay(T, -1); lbl = "yesterday"; break;
    case "yesterday": a = b = addDay(T, -1); ca = cb = addDay(T, -2); lbl = "the day before"; break;
    case "thisweek": a = mon; b = T; ca = addDay(mon, -7); cb = addDay(T, -7); lbl = "last week to this point"; break;
    case "lastweek": a = addDay(mon, -7); b = addDay(mon, -1); ca = addDay(mon, -14); cb = addDay(mon, -8); lbl = "the week before"; break;
    case "thismonth": a = mStart(T); b = T; ca = mStart(T, -1); cb = shiftM(T, -1); lbl = "last month to this point"; break;
    case "lastmonth": a = mStart(T, -1); b = mEnd(a); ca = mStart(T, -2); cb = mEnd(ca); lbl = "the month before"; break;
    case "thisq": a = q1; b = T; ca = mStart(q1, -3); cb = shiftM(T, -3); lbl = "last quarter to this point"; break;
    case "lastq": a = mStart(q1, -3); b = addDay(q1, -1); ca = mStart(q1, -6); cb = addDay(a, -1); lbl = "the quarter before"; break;
    case "thisyear": a = y1; b = T; ca = mStart(y1, -12); cb = shiftM(T, -12); lbl = "last year to this point"; break;
    case "l3m": case "l6m": case "l12m": { const n = {l3m:3, l6m:6, l12m:12}[R.p]; a = mStart(T, 1 - n); b = T; ca = mStart(a, -n); cb = shiftM(T, -n); lbl = "the " + n + " months before to this point"; break; }
    case "lastyear": a = mStart(y1, -12); b = addDay(y1, -1); ca = mStart(y1, -24); cb = addDay(a, -1); lbl = "the year before"; break;
    default: {
      if (R.p === "l30" || R.p === "l90") { const n = R.p === "l30" ? 30 : 90; a = addDay(T, 1 - n); b = T; }
      else { a = R.a || T; b = R.b || T; if (a > b) { const x = a; a = b; b = x; } if (b > T) b = T; }
      const n = daysIncl(a, b); ca = addDay(a, -n); cb = addDay(a, -1); lbl = "the previous " + n + " days";
      if (n === 1) lbl = "the day before";
    }
  }
  return { a, b, ca, cb, cmpLbl: lbl };
}
export const dkLabel = R => R.p === "custom" ? "Custom range" : (DK_PRESETS.find(x => x[0] === R.p) || DK_PRESETS[5])[1];
export const fmtSpan = (a, b) => { const T = todayYmd(); const f = d => MON[+d.slice(5,7) - 1] + " " + (+d.slice(8)); const y = a.slice(0,4) !== b.slice(0,4) || a.slice(0,4) !== T.slice(0,4);
  return a === b ? f(a) + (y ? ", " + a.slice(0,4) : "") : f(a) + (a.slice(0,4) !== b.slice(0,4) ? ", " + a.slice(0,4) : "") + " – " + f(b) + (y ? ", " + b.slice(0,4) : ""); };

// ─── SUMMARY TAB CONSTANTS (defined outside component to avoid remounting) ────
export const SUMMARY_RANGES = [
  {id:"7d",  label:"Last 7 days"},
  {id:"30d", label:"Last 30 days"},
  {id:"90d", label:"Last 3 months"},
  {id:"180d",label:"Last 6 months"},
  {id:"365d",label:"This year"},
  {id:"all", label:"All time"},
];

export const SUMMARY_METRICS = [
  {key:"weight",        label:"Weight",           unit:"lbs", col:"#60a5fa", lowerBetter:true},
  {key:"bodyFat",       label:"Body Fat",          unit:"%",   col:"#f87171", lowerBetter:true},
  {key:"fatMass",       label:"Fat Mass",          unit:"lbs", col:"#fb923c", lowerBetter:true},
  {key:"leanMass",      label:"Lean Mass",         unit:"lbs", col:"#4ade80"},
  {key:"hrv",           label:"HRV",               unit:"ms",  col:"#a78bfa"},
  {key:"restingHR",     label:"Resting HR",        unit:"bpm", col:"#fb7185", lowerBetter:true},
  {key:"vo2max",        label:"VO2 Max",           unit:"",    col:"#22d3ee"},
  {key:"sleepDur",      label:"Sleep",             unit:"hrs", col:"#818cf8"},
  {key:"deepSleep",     label:"Deep Sleep",        unit:"hrs", col:"#6366f1"},
  {key:"steps",         label:"Steps",             unit:"k",   col:"#34d399"},
  {key:"distanceMiles", label:"Distance",          unit:"mi",  col:"#86efac"},
  {key:"calories",      label:"Calories",          unit:"kcal",col:"#fbbf24"},
  {key:"protein",       label:"Protein",           unit:"g",   col:"#f97316"},
  {key:"carbs",         label:"Carbs",             unit:"g",   col:"#facc15"},
  {key:"fat",           label:"Fat",               unit:"g",   col:"#f9a8d4"},
  {key:"workoutVol",    label:"Workout Volume",    unit:"lbs", col:"#e879f9"},
  {key:"workoutDur",    label:"Workout Duration",  unit:"min", col:"#c084fc"},
  {key:"calsBurned",       label:"Active Calories",    unit:"kcal",col:"#2dd4bf"},
  {key:"spo2",             label:"SpO2",               unit:"%",   col:"#67e8f9"},
  // ── Body composition extended
  {key:"bmi",              label:"BMI",                unit:"",    col:"#94a3b8"},
  {key:"bmr",              label:"Basal Metabolic Rate",unit:"kcal",col:"#fcd34d"},
  {key:"muscleMass",       label:"Muscle Mass",        unit:"lbs", col:"#34d399"},
  {key:"boneMass",         label:"Bone Mass",          unit:"lbs", col:"#cbd5e1"},
  // ── Cardio extended
  {key:"avgHR",            label:"Avg Heart Rate",     unit:"bpm", col:"#f43f5e"},
  {key:"respiratoryRate",  label:"Respiratory Rate",   unit:"brpm",col:"#7dd3fc"},
  // ── Sleep extended
  {key:"remSleep",         label:"REM Sleep",          unit:"hrs", col:"#818cf8"},
  {key:"lightSleep",       label:"Core Sleep",         unit:"hrs", col:"#a5b4fc"},
  // ── Activity extended
  {key:"flightsClimbed",   label:"Flights Climbed",    unit:"",    col:"#6ee7b7"},
  // ── Nutrition extended
  {key:"fiber",            label:"Fiber",              unit:"g",   col:"#84cc16"},
  {key:"water",            label:"Water",              unit:"L",   col:"#38bdf8"},
  {key:"sugar",            label:"Sugar",              unit:"g",   col:"#fb923c", lowerBetter:true},
  {key:"sodium",           label:"Sodium",             unit:"mg",  col:"#f59e0b", lowerBetter:true},
  // ── Training extended
  {key:"fitbodSets",        label:"Total Sets",        unit:"",    col:"#d946ef"},
  {key:"fitbodWorkingSets", label:"Working Sets",      unit:"",    col:"#c026d3"},
  {key:"fitbodTotalReps",   label:"Total Reps",        unit:"",    col:"#a855f7"},
  {key:"fitbodExerciseCount",label:"Exercises",        unit:"",    col:"#8b5cf6"},
  {key:"fitbodMaxWeightLbs",label:"Max Weight Lifted", unit:"lbs", col:"#ec4899"},
  // ── Per-muscle group volume
  {key:"volChest",         label:"Chest Volume",       unit:"lbs", col:"#ef4444"},
  {key:"volBack",          label:"Back Volume",        unit:"lbs", col:"#f97316"},
  {key:"volShoulders",     label:"Shoulders Volume",   unit:"lbs", col:"#eab308"},
  {key:"volBiceps",        label:"Biceps Volume",      unit:"lbs", col:"#22c55e"},
  {key:"volTriceps",       label:"Triceps Volume",     unit:"lbs", col:"#14b8a6"},
  {key:"volLegs",          label:"Legs Volume",        unit:"lbs", col:"#3b82f6"},
  {key:"volCore",          label:"Core Volume",        unit:"lbs", col:"#7c3aed"},
  // ── Recovery & Sleep extended
  {key:"sleepScore",       label:"Sleep Score",        unit:"/100",col:"#818cf8"},
  {key:"readiness",        label:"Readiness",          unit:"/100",col:"#a78bfa"},
  {key:"hrRecovery",       label:"HR Recovery",        unit:"bpm", col:"#f43f5e"},
  {key:"sleepingWristTemp",label:"Wrist Temp",         unit:"°C",  col:"#67e8f9"},
  // ── Cardiovascular extended
  {key:"walkingHR",        label:"Walking HR",         unit:"bpm", col:"#fb7185", lowerBetter:true},
  {key:"bloodPressureSystolic",  label:"BP Systolic",  unit:"mmHg",col:"#f87171", lowerBetter:true},
  {key:"bloodPressureDiastolic", label:"BP Diastolic", unit:"mmHg",col:"#fca5a5", lowerBetter:true},
  {key:"bloodGlucose",     label:"Blood Glucose",      unit:"mg/dL",col:"#fbbf24"},
  {key:"bodyTemperature",  label:"Body Temp",          unit:"°C",  col:"#f97316"},
  // ── Activity extended
  {key:"standHours",       label:"Stand Hours",        unit:"hrs", col:"#4ade80"},
  {key:"exerciseMinutes",  label:"Exercise Minutes",   unit:"min", col:"#34d399"},
  {key:"activeCalories",   label:"Active Calories",    unit:"kcal",col:"#2dd4bf"},
  {key:"basalCalories",    label:"Basal Calories",     unit:"kcal",col:"#fcd34d"},
  {key:"totalCaloriesBurned",label:"Total Burn",       unit:"kcal",col:"#f59e0b"},
  {key:"distanceCyclingMiles",label:"Cycling Distance",unit:"mi",  col:"#60a5fa"},
  {key:"distanceSwimmingMeters",label:"Swim Distance", unit:"m",   col:"#38bdf8"},
  {key:"mindfulMinutes",   label:"Mindfulness",        unit:"min", col:"#c084fc"},
  {key:"walkingSteadiness",label:"Walk Steadiness",    unit:"%",   col:"#86efac"},
  // ── Mobility
  {key:"walkingSpeedKmh",  label:"Walking Speed",      unit:"km/h",col:"#6ee7b7"},
  {key:"walkingStepLengthM",label:"Step Length",       unit:"m",   col:"#a7f3d0"},
  {key:"walkingAsymmetry", label:"Walk Asymmetry",     unit:"%",   col:"#fca5a5", lowerBetter:true},
  {key:"sixMinWalkMeters", label:"6-Min Walk Test",    unit:"m",   col:"#34d399"},
  // ── Running
  {key:"runningSpeedKph",  label:"Run Speed",          unit:"km/h",col:"#22d3ee"},
  {key:"runningPower",     label:"Run Power",          unit:"W",   col:"#67e8f9"},
  {key:"runningStrideM",   label:"Run Stride",         unit:"m",   col:"#a5f3fc"},
  // ── Cycling
  {key:"cyclingSpeedKph",  label:"Cycling Speed",      unit:"km/h",col:"#3b82f6"},
  {key:"cyclingPower",     label:"Cycling Power",      unit:"W",   col:"#60a5fa"},
  {key:"cyclingCadence",   label:"Cycling Cadence",    unit:"rpm", col:"#93c5fd"},
  {key:"cyclingFTP",       label:"Cycling FTP",        unit:"W",   col:"#bfdbfe"},
  // ── Nutrition extended
  {key:"saturatedFat",     label:"Saturated Fat",      unit:"g",   col:"#f9a8d4", lowerBetter:true},
  {key:"cholesterol",      label:"Cholesterol",        unit:"mg",  col:"#fda4af", lowerBetter:true},
  {key:"potassium",        label:"Potassium",          unit:"mg",  col:"#86efac"},
  {key:"calcium",          label:"Calcium",            unit:"mg",  col:"#d9f99d"},
  {key:"iron",             label:"Iron",               unit:"mg",  col:"#fde68a"},
  {key:"vitaminC",         label:"Vitamin C",          unit:"mg",  col:"#fef08a"},
  {key:"caffeine",         label:"Caffeine",           unit:"mg",  col:"#d4a373"},
  // ── Meal breakdown
  {key:"breakfastCals",    label:"Breakfast",          unit:"kcal",col:"#fbbf24"},
  {key:"lunchCals",        label:"Lunch",              unit:"kcal",col:"#f97316"},
  {key:"dinnerCals",       label:"Dinner",             unit:"kcal",col:"#ef4444"},
  {key:"snackCals",        label:"Snacks",             unit:"kcal",col:"#fb923c"},
  // ── Body comp extended
  {key:"muscleRate",       label:"Muscle Rate",        unit:"%",   col:"#4ade80"},
  {key:"metabolicAge",     label:"Metabolic Age",      unit:"yrs", col:"#94a3b8"},
  {key:"visceralFat",      label:"Visceral Fat",       unit:"",    col:"#f87171", lowerBetter:true},
  {key:"subcutaneousFat",  label:"Subcut. Fat",        unit:"%",   col:"#fca5a5", lowerBetter:true},
  {key:"proteinMass",      label:"Protein Mass",       unit:"lbs", col:"#86efac"},
  {key:"waistCircumference",label:"Waist",             unit:"in",  col:"#94a3b8", lowerBetter:true},
];

export const GROUP_DESC = {
  body:"Smart scale or body scan · latest reading in the range",
  segmental:"Body scan · latest scan",
  sleep:"Sleep tracker · nightly average",
  nutrition:"Food log · daily average",
  mealTiming:"Logged manually · latest entry",
  activity:"Apple Health · totals and daily averages",
  training:"Workout log · totals for the range",
  measurements:"Logged manually · latest reading",
  custom:"Your own metrics from Manual Entry · latest reading",
  hk_activity:"Apple Health · every app and device",hk_heart:"Apple Health · every app and device",
  hk_sleep:"Apple Health · every app and device",hk_body:"Apple Health · every app and device",
  hk_mobility:"Apple Health · every app and device",hk_nutrition:"Apple Health · every app and device",
  hk_environment:"Apple Health · every app and device",hk_events:"Apple Health · days with entries",
  volByGroup:"Fitbod · totals for the range",
};
export const SRC_NAME = {"HUME":"Hume","HUME BODY POD":"Hume Body Pod","OURA":"Oura","MYFITNESSPAL":"MyFitnessPal","MANUAL":"Manual entry","APPLE HEALTH":"Apple Health","FITBOD":"Fitbod"};
export const KPI_TEXT_KEYS = new Set(["workoutType","fitbodMuscleGroups"]);
export const KPI_LAST_GROUPS = new Set(["body","segmental","measurements","custom"]);
export const KPI_LAST_KEYS = new Set(["vo2max","bmr","metabolicAge","fitbodMaxWeightLbs","walkingSteadiness"]);
export const KPI_SUM_RE = /^(steps|calsBurned|activeMins|flightsClimbed|workoutVol|workoutDur|fitbodSets|fitbodWorkingSets|fitbodTotalReps|(vol|reps|sets)[A-Z])/;
// sum: totals for the range ("X per day"); avg: average of days logged; last: latest reading
export function kpiMode(gid, k) {
  if (KPI_LAST_GROUPS.has(gid) || KPI_LAST_KEYS.has(k) || /^max[A-Z]/.test(k) || /^(trunk|rightArm|leftArm|rightLeg|leftLeg)(Fat|Muscle)$/.test(k)) return "last";
  if (KPI_SUM_RE.test(k)) return "sum";
  return "avg";
}
export function aggVals(arr, mode) {
  const n = arr.filter(v => v != null);
  if (!n.length) return null;
  if (mode === "last") return n[n.length - 1];
  const s = n.reduce((a, b) => a + b, 0);
  return mode === "sum" ? s : s / n.length;
}
export function btFmt(v, u) {
  if (v == null || typeof v !== "number" || !isFinite(v)) return "—";
  const a = Math.abs(v);
  const n = a >= 1e6 ? (v / 1e6).toFixed(2).replace(/\.?0+$/, "") + "M"
    : a >= 1e4 ? (v / 1e3).toFixed(a >= 1e5 ? 0 : 1).replace(/\.0$/, "") + "K"
    : a >= 1000 ? Math.round(v).toLocaleString()
    : a >= 10 ? String(Math.round(v * 10) / 10)          // 174.5 lb, 47 mL/kg/min
    : String(Math.round(v * 100) / 100);                 // 0.88 RER, 1.29 g/cm², 7.25 h
  const suf = {"k":"","%":"%","lbs":" lb","hrs":"h","ms":" ms","bpm":" bpm","kcal":" kcal","g":"g","min":" min","L":"L","mg":" mg","in":"\"","yrs":" yrs","/100":"","/min":"/min","°C":"°C"}[u];
  return n + (suf != null ? suf : (u ? " " + u : ""));
}
export const dayKey = d => {
  if (d.ymd) return d.ymd;
  const p = parseSyncDateRobust(d.syncDate || d.date);
  return p && !isNaN(p.getTime()) ? ymdOf(p) : null;
};
// "Brandon’s Apple Watch" → "Apple Watch", "Brandon’s iPhone (3)" → "iPhone"
export const appName = a => String(a).replace(/\u00a0/g, " ").replace(/^.*?[’']s\s+/, "").replace(/\s*\(\d+\)$/, "");
// ─── ALL APPLE HEALTH DATA (sent by the iPhone app as hk_* / hkc_* / hkw_*) ───
export const HK_SECTIONS = [
  ["hk_nutrition","APPLE HEALTH · NUTRITION",/^Dietary/],
  ["hk_heart","APPLE HEALTH · HEART & VITALS",/Heart|Atrial|Oxygen|Perfusion|Respiratory|(?<!Water)Temperature|Breathing|Blood|Insulin|Electrodermal|Inhaler|Forced|Expiratory|Fallen|Alcohol|VO2Max/],
  ["hk_sleep","APPLE HEALTH · SLEEP & MIND",/^(SleepAnalysis|MindfulSession|SleepApneaEvent)$/],
  ["hk_body","APPLE HEALTH · BODY",/^(BodyMass|BodyFat|Height|LeanBody|Waist)/],
  ["hk_mobility","APPLE HEALTH · MOBILITY",/^(Walking|Stair|SixMinute|AppleWalking)/],
  ["hk_environment","APPLE HEALTH · ENVIRONMENT",/Audio|Sound|UVExposure|Daylight|Underwater|WaterTemperature/],
  ["hk_activity","APPLE HEALTH · ACTIVITY",/^w_|Step|Distance|Energy|Flights|Push|Swimming|Exercise|Stand|Move|Effort|Rowing|Paddle|Skiing|Cycling|Running|Workout/],
  ["hk_events","APPLE HEALTH · EVENTS & SYMPTOMS",/^c_/],
];
// Which way is "good" for each Apple Health type (matched on the type name, e.g. "RestingHeartRate")
export const HK_LOWER = /^(RestingHeartRate|WalkingHeartRateAverage|BloodPressure|BloodGlucose|BloodAlcoholContent|WalkingAsymmetryPercentage|WalkingDoubleSupportPercentage|NumberOfTimesFallen|NumberOfAlcoholicBeverages|RunningGroundContactTime|RunningVerticalOscillation|BodyFatPercentage|BodyMass$|BodyMassIndex|WaistCircumference|DietarySodium|DietarySugar|DietaryCholesterol|DietaryFatSaturated|DietaryCaffeine|AppleSleepingBreathingDisturbances|EnvironmentalAudioExposure|HeadphoneAudioExposure)/;
export const HK_NEUTRAL = /^(HeartRate$|DietaryEnergyConsumed|DietaryCarbohydrates|DietaryFatTotal|DietaryFatMonounsaturated|DietaryFatPolyunsaturated|RespiratoryRate|BodyTemperature|BasalBodyTemperature|AppleSleepingWristTemperature|ElectrodermalActivity|InsulinDelivery|UVExposure|Height|EnvironmentalSoundReduction|WaterTemperature|UnderwaterDepth|InhalerUsage)/;
export const HKC_HIGHER = /^(SleepAnalysis|MindfulSession|AppleStandHour|ToothbrushingEvent|HandwashingEvent)$/;
export const HKC_NEUTRAL = /^(SexualActivity|MenstrualFlow|IntermenstrualBleeding|OvulationTestResult|CervicalMucusQuality|Pregnancy|Lactation|Contraceptive|PregnancyTestResult|ProgesteroneTestResult|InfrequentMenstrualCycles|IrregularMenstrualCycles|PersistentIntermenstrualBleeding|ProlongedMenstrualPeriods|BleedingAfterPregnancy|BleedingDuringPregnancy)$/;
export function hkDirection(k) {
  const raw = k.replace(/^hk[cw]?_/, ""), name = raw.charAt(0).toUpperCase() + raw.slice(1);
  if (k.startsWith("hkw_")) return {lib: false, neu: false};
  if (k.startsWith("hkc_")) return HKC_HIGHER.test(name) ? {lib: false, neu: false} : HKC_NEUTRAL.test(name) ? {lib: false, neu: true} : {lib: true, neu: false}; // symptoms & alerts: fewer is better
  return {lib: HK_LOWER.test(name), neu: HK_NEUTRAL.test(name)};
}
export const hkUnit = u => ({"appleEffortScore":"/10","kcal/hr·kg":"MET","count/min":"bpm","count":"","%":"%","degC":"°C","degF":"°F","kcal":"kcal","Cal":"kcal","min":"min","hr":"hrs","ms":"ms","lb":"lbs","mi":"mi","km":"km","m":"m","cm":"cm","in":"in","ft":"ft","g":"g","mg":"mg","mcg":"mcg","mL":"mL","L":"L","fl_oz_us":"fl oz","dBASPL":"dB","mmHg":"mmHg","mg/dL":"mg/dL","W":"W","m/s":"m/s","km/hr":"km/h","mi/hr":"mph"}[u] ?? u);
export const hkLabel = k => { let n = k.replace(/^hk[cw]?_/, "").replace(/^dietary/, "").replace(/^apple/, "").replace(/Event$/, ""); n = n.charAt(0).toLowerCase() + n.slice(1);
  const fix = {count:"Workouts", minutes:"Workout minutes", vO2Max:"VO2 Max", heartRateVariabilitySDNN:"HRV (SDNN)", sleepAnalysis:"Time asleep", mindfulSession:"Mindful minutes", standHour:"Stand hours", bodyMass:"Weight", stepCount:"Steps", energyConsumed:"Calories in", heartRate:"Heart rate"};
  return fix[n] || n.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, c => c.toUpperCase()); };
export function hkGroups(rows) {
  const meta = {}; const keys = new Set();
  for (const d of rows) { if (d.hkMeta) Object.assign(meta, d.hkMeta); for (const k in d) if (/^hk[cw]?_/.test(k) && k !== "hkMeta" && typeof d[k] === "number") keys.add(k); }
  const out = HK_SECTIONS.map(([id, name]) => ({id, name, src:"APPLE HEALTH", rows: []})), used = new Set();
  for (const k of [...keys].sort()) {
    const raw = k.replace(/^hk[cw]?_/, ""), name = raw.charAt(0).toUpperCase() + raw.slice(1);
    const isCat = k.startsWith("hkc_"), isW = k.startsWith("hkw_");
    let i = isW ? HK_SECTIONS.findIndex(([id]) => id === "hk_activity")
      : HK_SECTIONS.findIndex(([id, , re]) => (isCat ? (id === "hk_sleep" || id === "hk_heart" || id === "hk_mobility" || id === "hk_environment" || (id === "hk_activity" && /Stand/.test(name))) && re.test(name) : id !== "hk_events" && re.test(name)));
    if (i < 0) i = HK_SECTIONS.findIndex(([id]) => id === (isCat ? "hk_events" : "hk_activity"));
    const g = out[i];
    const [u, agg, label] = meta[k] || ["", "avg"];
    g.rows.push({k, l: label ? appName(label) : hkLabel(k), u: hkUnit(u), mode: agg === "sum" ? "sum" : "avg", ...hkDirection(k)}); used.add(k);
  }
  return out.filter(g => g.rows.length);
}
export const SEC_SRC = {existing:"BODYDATA", manual:"FILE IMPORT", api:"API", mcp:"MCP", agent:"BODYDATA AGENT"};
export function buildKpiBoard(allData, r, sections = []) {
  const idx = new Map();
  // same-day rows from different sources (Apple Health, MyFitnessPal…) merge; the newer row wins on conflicts
  const rows = [...allData].sort((a, b) => String(a._rx || "").localeCompare(String(b._rx || "")));
  for (const d of rows) { const k = dayKey(d); if (!k) continue; const e = idx.get(k);
    idx.set(k, e ? {...e, ...d, hkSources: {...(e.hkSources || {}), ...(d.hkSources || {})}, hkMeta: {...(e.hkMeta || {}), ...(d.hkMeta || {})}} : d); }
  // Custom metrics (from Manual Entry uploads) become their own section
  const cdefs = {};
  for (const d of rows) { if (d.customDefs) Object.assign(cdefs, d.customDefs); for (const k in d) if (k.startsWith("c_") && !cdefs[k]) cdefs[k] = {l: k.slice(2), u: ""}; }
  // AI/user-defined sections come first, each with its own KPIs, direction and source
  const owned = new Set(sections.flatMap(s => s.kpis.filter(k => !k.existing).map(k => k.key)));
  const extraGroups = sections.map(s => ({id: "sec_" + s.id, name: s.name.toUpperCase(), src: (s.source?.app || SEC_SRC[s.source?.type] || "CUSTOM").toUpperCase(), section: s,
    desc: s.description || (s.source?.app ? `From ${s.source.app}` : ""),
    rows: s.kpis.map(k => ({k: k.key, l: k.label, u: k.unit || "", mode: k.agg, lib: k.direction === "down", neu: k.direction === "neutral"}))}));
  const loose = Object.entries(cdefs).filter(([k]) => !owned.has(k));
  if (loose.length) extraGroups.push({id:"custom", name:"CUSTOM METRICS", src:"MANUAL",
    rows: loose.map(([k, d]) => ({k, l: d.l || k.slice(2), u: d.u || "", lib: !!d.lb}))});
  extraGroups.push(...hkGroups(rows));
  const days = dayList(r.a, r.b), cdays = dayList(r.ca, r.cb);
  const daily = days.length <= 45;
  let buckets;
  if (daily) buckets = days.map(s => ({label: shortDay(s), days: [s]}));
  else {
    const multi = r.a.slice(0,4) !== r.b.slice(0,4), m = new Map();
    for (const s of days) { const ym = s.slice(0,7); if (!m.has(ym)) m.set(ym, []); m.get(ym).push(s); }
    buckets = [...m].map(([ym, ds]) => ({label: MON[+ym.slice(5) - 1] + (multi ? " '" + ym.slice(2,4) : ""), days: ds}));
  }
  const smByKey = Object.fromEntries(SUMMARY_METRICS.map(m => [m.key, m]));
  const T = todayYmd(), groups = {}, byId = {};
  for (const g of [...GROUPS, ...extraGroups]) {
    groups[g.id] = g.rows.map(row => {
      const sm = smByKey[row.k];
      const unit = sm?.unit || row.u || "";
      const lb = !!(sm?.lowerBetter || row.fat || row.lib);
      const base = {id: g.id + ":" + row.k, k: row.k, label: row.l, unit, lb, neu: !!row.neu || g.id === "custom", src: g.src, gid: g.id};
      if (row.type === "time" || KPI_TEXT_KEYS.has(row.k)) {
        const curPts = days.map(s => [s, idx.get(s)?.[row.k]]).filter(p => p[1] != null && p[1] !== "");
        const last = curPts[curPts.length - 1];
        const c = {...base, text: true, mode: "last", fmt: last ? String(last[1]) : "—", curPts,
          sub: last ? "latest · " + shortDay(last[0]) : "no entries in this range"};
        byId[c.id] = c; return c;
      }
      const mode = row.mode || kpiMode(g.id, row.k);
      const appSet = new Set(); for (const s of days) for (const a of idx.get(s)?.hkSources?.[row.k] || []) appSet.add(appName(a));
      const apps = [...appSet].sort();
      const get = s => { const x = idx.get(s)?.[row.k]; return typeof x === "number" && isFinite(x) ? x : null; };
      const cur = days.map(get), prv = cdays.map(get);
      const value = aggVals(cur, mode), prev = aggVals(prv, mode);
      const pts = unit === "%";
      const delta = value != null && prev != null ? (pts ? value - prev : prev !== 0 ? (value - prev) / Math.abs(prev) * 100 : null) : null;
      const vals = buckets.map(b => aggVals(b.days.map(get), mode));
      const curPts = days.map((s, i) => [s, cur[i]]).filter(p => p[1] != null);
      const logged = curPts.length;
      const sub = value == null ? "no data in this range"
        : mode === "sum" ? `${btFmt(value / days.length, unit)} per day`
        : mode === "avg" ? `daily average · ${logged} day${logged === 1 ? "" : "s"} logged`
        : `latest · ${shortDay(curPts[logged - 1][0])}`;
      const c = {...base, apps, mode, value, prev, delta, pts, fmt: btFmt(value, unit), prevFmt: btFmt(prev, unit), sub,
        labels: buckets.map(b => b.label), vals, curPts, partial: daily && r.b === T};
      byId[c.id] = c; return c;
    });
  }
  const ever = new Set();
  for (const d of idx.values()) for (const k in d) { const v = d[k]; if (v != null && v !== "" && !(typeof v === "number" && !isFinite(v))) ever.add(k); }
  const emptyGroups = new Set(GROUPS.filter(g => !g.rows.some(row => ever.has(row.k))).map(g => g.id));
  return {groups, byId, extraGroups, emptyGroups};
}


// ─── METRIC DETAIL (Metrics tab on web + iPhone) ───
export const WD = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
// Same-day rows merged, newest wins (same rule as the KPI board)
export function dayIndex(allData) {
  const m = new Map();
  for (const d of [...allData].sort((a, b) => String(a._rx || "").localeCompare(String(b._rx || "")))) { const k = dayKey(d); if (!k) continue; const e = m.get(k);
    m.set(k, e ? {...e, ...d, hkSources: {...(e.hkSources || {}), ...(d.hkSources || {})}} : d); }
  return m;
}
export function resolveRange(range, idx) {
  if (range?.p === "all") { const first = [...idx.keys()].sort()[0] || todayYmd(); return {...dkRange({p: "custom", a: first, b: todayYmd()}), label: "All time"}; }
  return {...dkRange(range || {p: "l90"}), label: dkLabel(range || {p: "l90"})};
}
export function mxBuckets(days, g) {
  if (g === "days") return days.map(s => ({label: shortDay(s), key: s, days: [s]}));
  const m = new Map();
  for (const s of days) {
    let k, label;
    if (g === "weeks") { const d = new Date(s + "T12:00:00"); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); k = ymdOf(d); label = shortDay(k); }
    else { k = s.slice(0, 7); label = MON[+k.slice(5) - 1] + " '" + k.slice(2, 4); }
    if (!m.has(k)) m.set(k, {label, key: k, days: []}); m.get(k).days.push(s);
  }
  return [...m.values()];
}
// card: a KPI board card (from buildKpiBoard over the same range)
export function metricDetail(idx, card, r, gran = "auto") {
  const get = s => { const v = idx.get(s)?.[card.k]; return typeof v === "number" && isFinite(v) ? v : null; };
  const days = dayList(r.a, r.b);
  const g = gran !== "auto" ? gran : days.length <= 62 ? "days" : days.length <= 400 ? "weeks" : "months";
  const perDay = card.mode === "sum" && g !== "days";   // totals charted per day in week/month view
  const buckets = mxBuckets(days, g).map(b => ({label: b.label, key: b.key, v: aggVals(b.days.map(get), perDay ? "avg" : card.mode)}));
  const daily = days.map(s => [s, get(s)]).filter(p => p[1] != null);
  const win = end => aggVals(dayList(addDay(end, -29), end).map(get), card.mode);
  const now = win(r.b);
  const cmp = [["Current", 0], ["1 month ago", 1], ["3 months ago", 3], ["6 months ago", 6], ["12 months ago", 12], ["24 months ago", 24]].map(([l, n]) => {
    const v = n ? win(shiftM(r.b, -n)) : now;
    const d = n && v != null && now != null ? (card.pts ? now - v : v !== 0 ? (now - v) / Math.abs(v) * 100 : null) : null;
    return {l, v, fmt: btFmt(v, card.unit), d};
  });
  const wdVals = WD.map((_, i) => { const v = daily.filter(([s]) => new Date(s + "T12:00:00").getDay() === i).map(p => p[1]); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; });
  const weekday = card.mode === "last" ? [] : [1, 2, 3, 4, 5, 6, 0].map(i => ({day: WD[i], v: wdVals[i]}));
  const wn = weekday.map(w => w.v).filter(v => v != null);
  const bestDay = wn.length ? weekday.find(w => w.v === (card.lb ? Math.min(...wn) : Math.max(...wn)))?.day : null;
  const srcCount = {}; for (const s of days) for (const a of idx.get(s)?.hkSources?.[card.k] || []) { const n = appName(a); srcCount[n] = (srcCount[n] || 0) + 1; }
  const sources = Object.entries(srcCount).sort((a, b) => b[1] - a[1]);
  const how = card.mode === "sum" ? "total" : card.mode === "avg" ? "daily average" : "latest reading";
  return {g, perDay, buckets, daily, cmp, weekday, bestDay, sources, how, days: days.length};
}

// ─── SAME MEASURE, DIFFERENT SOURCES (DexaFit says X, Apple Health says Y) ───
// Standard measures a report KPI can be linked to with `sameAs`
export const COMPARABLE = ["weight", "bodyFat", "fatMass", "leanMass", "muscleMass", "boneMass", "bmi", "bmr", "restingHR", "vo2max", "hrv", "spo2", "respiratoryRate", "bloodPressureSystolic", "bloodPressureDiastolic"];
// Best guess when the AI didn't link it: label + unit → standard measure
export function guessSameAs(label, unit) {
  const l = String(label || "").toLowerCase().replace(/\s+/g, " ").trim(), u = String(unit || "").toLowerCase();
  const mass = /^(lb|lbs|kg|pounds?)$/.test(u), pct = u === "%";
  if (pct && /^(total )?body fat( %| percent(age)?)?$/.test(l)) return "bodyFat";
  if (mass && /^(total )?(lean mass|lean body mass)$/.test(l)) return "leanMass";
  if (mass && /^(total )?fat mass$/.test(l)) return "fatMass";
  if (mass && /^(total mass|total body mass|weight|body weight|scale weight)$/.test(l)) return "weight";
  if (mass && /^(skeletal )?muscle mass$/.test(l)) return "muscleMass";
  if (mass && /^(bone mass|bone mineral content)$/.test(l)) return "boneMass";
  if (/^bmi$|body mass index/.test(l)) return "bmi";
  if (/resting metabolic rate|^rmr\b|basal metabolic rate|^bmr\b/.test(l) && /kcal|cal/.test(u)) return "bmr";
  if (/^(resting heart rate|resting hr|rhr)$/.test(l)) return "restingHR";
  if (/^vo2 ?max$/.test(l) && /ml\/kg/.test(u)) return "vo2max";
  if (/^(hrv|heart rate variability)/.test(l)) return "hrv";
  return "";
}
const UNIT_TO_LB = {kg: 2.20462, lb: 1, lbs: 1, pounds: 1, pound: 1};
// Latest reading of `key` and of every section KPI linked to it, one row per source
export function sourceCompare(idx, sections, key, unit = "") {
  const out = [], dates = [...idx.keys()].sort();
  const latest = (k) => { for (let i = dates.length - 1; i >= 0; i--) { const v = idx.get(dates[i])?.[k]; if (typeof v === "number" && isFinite(v)) return [dates[i], v]; } return null; };
  const count = (k) => dates.reduce((n, s) => n + (typeof idx.get(s)?.[k] === "number" ? 1 : 0), 0);
  const linked = (sections || []).flatMap(s => (s.kpis || []).filter(k => k.sameAs === key && k.key !== key).map(k => [s, k]));
  unit = unit || linked[0]?.[1].unit || "";
  // Daily totals (resting energy) aren't a single reading: compare a 7-day average of complete days
  const T = todayYmd(), avgDays = {bmr: 7}[key];
  let base = latest(key);
  if (avgDays) {
    const done = dates.filter(s => s < T && typeof idx.get(s)?.[key] === "number").slice(-avgDays);
    base = done.length ? [done[done.length - 1], done.reduce((a, s) => a + idx.get(s)[key], 0) / done.length] : null;
  }
  if (base) {
    const apps = (idx.get(base[0])?.hkSources?.[key] || []).map(appName);
    out.push({source: apps.length ? apps.join(", ") : "Apple Health", via: avgDays ? `Apple Health · ${avgDays}-day average` : "Apple Health", key, date: base[0], value: base[1], fmt: btFmt(base[1], unit), readings: count(key)});
  }
  for (const [s, k] of linked) {
    const p = latest(k.key); if (!p) continue;
    const f = (UNIT_TO_LB[String(k.unit).toLowerCase()] && unit === "lbs") ? UNIT_TO_LB[String(k.unit).toLowerCase()] : 1;
    const v = p[1] * f;
    out.push({source: s.source?.app || s.name, via: s.name, key: k.key, date: p[0], value: v, fmt: btFmt(v, unit || k.unit), readings: count(k.key)});
  }
  if (out.length < 2) return [];
  const ref = out[0].value;
  const gap = (d) => { const a = Math.abs(d) >= 100 ? Math.round(Math.abs(d)) : Math.round(Math.abs(d) * 10) / 10; return (d >= 0 ? "+" : "−") + (unit === "%" ? btFmt(a, "") + " pts" : btFmt(a, unit)); };
  return out.map((o, i) => ({...o, diff: i && ref != null ? o.value - ref : null, diffFmt: i && ref != null ? gap(o.value - ref) : ""}));
}
