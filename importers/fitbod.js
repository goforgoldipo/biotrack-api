// Fitbod "Export workout data" CSV → one BioTrack snapshot per day (sets, reps, volume per muscle group).
// Same aggregation the original import-fitbod.js script used, now run server-side.
const KG_TO_LBS = 2.20462;

// Quote-aware CSV parser (Fitbod notes can contain commas)
function parseCSVText(text) {
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += ch;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  const clean = rows.filter(r => r.some(c => c.trim() !== ""));
  if (!clean.length) return { headers: [], records: [] };
  const headers = clean[0].map(h => h.trim().replace(/^\uFEFF/, ""));
  const records = clean.slice(1).map(r => Object.fromEntries(headers.map((h, i) => [h, (r[i] || "").trim()])));
  return { headers, records };
}

function isFitbodCSV(headers) {
  const h = new Set(headers);
  return h.has("Date") && h.has("Exercise") && h.has("Reps") && (h.has("Weight(kg)") || h.has("Weight(lbs)"));
}

function aggregateByDay(rows) {
  const days = {};

  for (const row of rows) {
    const dateStr = row.Date?.slice(0, 10);
    if (!dateStr || dateStr === "Date") continue;

    if (!days[dateStr]) {
      days[dateStr] = {
        date: dateStr,
        sets: 0,
        workingSets: 0,
        warmupSets: 0,
        totalReps: 0,
        totalVolLbs: 0,
        maxWeightLbs: 0,
        exercises: {},
        exerciseOrder: [],
        muscleGroups: new Set(),
      };
    }

    const d = days[dateStr];
    const exercise = row.Exercise?.trim() || "Unknown";
    const reps = parseInt(row.Reps) || 0;
    const weightLbs = row["Weight(lbs)"] != null && row["Weight(lbs)"] !== "" ? (parseFloat(row["Weight(lbs)"]) || 0) : (parseFloat(row["Weight(kg)"]) || 0) * KG_TO_LBS;
    const multiplier = parseFloat(row.multiplier) || 1;
    const isWarmup = row.isWarmup?.toLowerCase() === "true";
    const duration = parseFloat(row["Duration(s)"]) || 0;
    const distance = parseFloat(row["Distance(m)"]) || 0;

    const volume = reps * weightLbs * multiplier;

    d.sets++;
    if (isWarmup) d.warmupSets++;
    else d.workingSets++;
    d.totalReps += reps;
    d.totalVolLbs += volume;
    if (weightLbs > d.maxWeightLbs) d.maxWeightLbs = weightLbs;

    if (!d.exercises[exercise]) {
      d.exercises[exercise] = { sets: 0, reps: 0, vol: 0, maxWeight: 0, warmupSets: 0, duration: 0, distance: 0 };
      d.exerciseOrder.push(exercise);
    }
    const ex = d.exercises[exercise];
    ex.sets++;
    ex.reps += reps;
    ex.vol += volume;
    if (weightLbs > ex.maxWeight) ex.maxWeight = weightLbs;
    if (isWarmup) ex.warmupSets++;
    ex.duration += duration;
    ex.distance += distance;

    // Categorize muscle group from exercise name
    const name = exercise.toLowerCase();
    let mg = "Other";
    // Specific overrides first to prevent substring false-positives
    if (name.includes("calf")) mg = "Legs"; // calf raise/press → Legs not Shoulders
    else if (name.includes("kickback")) mg = "Triceps"; // "kickback" contains "back"
    else if (name.includes("hamstring") || name.includes("leg curl")) mg = "Legs"; // leg curls → Legs not Biceps
    else if (name.includes("bench") || name.includes("chest") || name.includes("push up") ||
             (name.includes("fly") && !name.includes("delt") && !name.includes("back"))) mg = "Chest";
    else if (name.includes("curl") || name.includes("bicep")) mg = "Biceps";
    else if (name.includes("tricep") || name.includes("skull") || name.includes("pushdown") ||
             name.includes("dip") || name.includes("overhead extension")) mg = "Triceps";
    else if (name.includes("shoulder") || name.includes("delt") ||
             (name.includes("raise") && !name.includes("knee")) || // exclude knee raise (Core)
             name.includes("shrug") || name.includes("upright row") || name.includes("jerk")) mg = "Shoulders";
    else if (name.includes("squat") || name.includes("leg") || name.includes("lunge") ||
             name.includes("hip thrust") || name.includes("glute") ||
             name.includes("adduct") || name.includes("abduct") ||
             name.includes("step up") || name.includes("hip extension") || name.includes("wall sit")) mg = "Legs";
    else if (name.includes("row") || name.includes("pull") || name.includes("lat") ||
             name.includes("back") || name.includes("deadlift") || name.includes("chin") ||
             name.includes("superman") || name.includes("good morning")) mg = "Back";
    else if (/\babs?\b/.test(name) || name.includes("crunch") || name.includes("plank") ||
             name.includes("core") || name.includes("sit up") || name.includes("situp") ||
             name.includes("russian twist") || name.includes("scissor") ||
             name.includes("toes to bar") || name.includes("toe touch") ||
             name.includes("side bend") || name.includes("knee raise") ||
             name.includes("leg raise")) mg = "Core";
    else if (name.includes("running") || name.includes("treadmill") || name.includes("cycling") ||
             name.includes("cardio") || name.includes("elliptical") || name.includes("walking") ||
             name.includes("swim") || name.includes("burpee") || name.includes("box jump") ||
             name.includes("air bike") || name.includes("jump rope")) mg = "Cardio";
    else if (name.includes("press") && !name.includes("leg")) mg = "Shoulders";
    d.muscleGroups.add(mg);

    // Track per-muscle-group stats
    if (!d.mgStats) d.mgStats = {};
    if (!d.mgStats[mg]) d.mgStats[mg] = { vol: 0, reps: 0, sets: 0, maxWeight: 0 };
    d.mgStats[mg].vol += volume;
    d.mgStats[mg].reps += reps;
    d.mgStats[mg].sets++;
    if (weightLbs > d.mgStats[mg].maxWeight) d.mgStats[mg].maxWeight = weightLbs;
  }

  return days;
}

function buildSnapshot(dateStr, day) {
  const d = new Date(dateStr + "T12:00:00Z");
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const syncDate = `${months[d.getUTCMonth()]} ${d.getUTCDate()} ${d.getUTCFullYear()}`;
  const syncTime = "12:00 PM";

  // Determine workout type from muscle groups
  const groups = Array.from(day.muscleGroups);
  let workoutType = "Strength";
  if (groups.includes("Cardio") && groups.length === 1) workoutType = "Cardio";
  else if (groups.includes("Chest") || groups.includes("Triceps")) workoutType = "Push";
  else if (groups.includes("Back") || groups.includes("Biceps")) workoutType = "Pull";
  else if (groups.includes("Legs")) workoutType = "Legs";
  else if (groups.includes("Shoulders")) workoutType = "Push";
  else if (groups.includes("Core")) workoutType = "Core";

  // Build exercises summary string
  const exerciseSummary = day.exerciseOrder.slice(0, 8).join(", ");

  return {
    syncDate,
    syncTime,
    // Fitbod-specific fields
    workoutType,
    workoutVol: Math.round(day.totalVolLbs),
    workoutDuration: null, // Fitbod CSV doesn't have total workout duration
    exercises: exerciseSummary,
    fitbodSets: day.sets,
    fitbodWorkingSets: day.workingSets,
    fitbodWarmupSets: day.warmupSets,
    fitbodTotalReps: day.totalReps,
    fitbodMaxWeightLbs: +day.maxWeightLbs.toFixed(1),
    fitbodExerciseCount: day.exerciseOrder.length,
    fitbodMuscleGroups: groups.join(", "),
    fitbodExercises: day.exerciseOrder.join(" | "),
    // Per-muscle-group volume (lbs), reps, sets, max weight
    volChest:     Math.round(day.mgStats?.Chest?.vol     || 0) || null,
    volBack:      Math.round(day.mgStats?.Back?.vol      || 0) || null,
    volShoulders: Math.round(day.mgStats?.Shoulders?.vol || 0) || null,
    volBiceps:    Math.round(day.mgStats?.Biceps?.vol    || 0) || null,
    volTriceps:   Math.round(day.mgStats?.Triceps?.vol   || 0) || null,
    volLegs:      Math.round(day.mgStats?.Legs?.vol      || 0) || null,
    volCore:      Math.round(day.mgStats?.Core?.vol      || 0) || null,
    repsChest:     day.mgStats?.Chest?.reps     || null,
    repsBack:      day.mgStats?.Back?.reps      || null,
    repsShoulders: day.mgStats?.Shoulders?.reps || null,
    repsBiceps:    day.mgStats?.Biceps?.reps    || null,
    repsTriceps:   day.mgStats?.Triceps?.reps   || null,
    repsLegs:      day.mgStats?.Legs?.reps      || null,
    repsCore:      day.mgStats?.Core?.reps      || null,
    setsChest:     day.mgStats?.Chest?.sets     || null,
    setsBack:      day.mgStats?.Back?.sets      || null,
    setsShoulders: day.mgStats?.Shoulders?.sets || null,
    setsBiceps:    day.mgStats?.Biceps?.sets    || null,
    setsTriceps:   day.mgStats?.Triceps?.sets   || null,
    setsLegs:      day.mgStats?.Legs?.sets      || null,
    setsCore:      day.mgStats?.Core?.sets      || null,
    maxChest:      +(day.mgStats?.Chest?.maxWeight?.toFixed(1)     || 0) || null,
    maxBack:       +(day.mgStats?.Back?.maxWeight?.toFixed(1)      || 0) || null,
    maxShoulders:  +(day.mgStats?.Shoulders?.maxWeight?.toFixed(1) || 0) || null,
    maxBiceps:     +(day.mgStats?.Biceps?.maxWeight?.toFixed(1)    || 0) || null,
    maxTriceps:    +(day.mgStats?.Triceps?.maxWeight?.toFixed(1)   || 0) || null,
    maxLegs:       +(day.mgStats?.Legs?.maxWeight?.toFixed(1)      || 0) || null,
    maxCore:       +(day.mgStats?.Core?.maxWeight?.toFixed(1)      || 0) || null,
  };
}


// Returns [{date: "YYYY-MM-DD", snapshot}] for every day in the export
function fitbodSnapshots(records) {
  const days = aggregateByDay(records);
  return Object.keys(days).sort().map(date => {
    const snap = buildSnapshot(date, days[date]);
    for (const k of Object.keys(snap)) if (snap[k] === null) delete snap[k];
    return { date, snapshot: { ...snap, syncDate: date, source: "Fitbod export" } };
  });
}

module.exports = { parseCSVText, isFitbodCSV, fitbodSnapshots };
