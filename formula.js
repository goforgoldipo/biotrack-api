// ─────────────────────────────────────────────────────────────────
//  Safe formulas for derived metrics (no eval). Examples:
//    weight * (1 - bodyFat / 100)                lean mass from scale + body fat
//    protein / weight                            g per lb
//    avg(hrv, 7) - avg(hrv, 28)                  HRV vs its baseline
//    sum(steps, 7)                               weekly steps
//    pct_change(weight, 28)                      % change over 4 weeks
//  Variables are metric keys (letters, digits, _). Rolling functions look back over days.
// ─────────────────────────────────────────────────────────────────
const FUNCS1 = { abs: Math.abs, round: Math.round, sqrt: Math.sqrt, log: Math.log, exp: Math.exp };
const FUNCSN = { min: Math.min, max: Math.max };
const ROLLING = ["avg", "sum", "min7", "max7", "count", "pct_change", "delta", "prev"];   // fn(metric, days)

function tokenize(src) {
  const out = []; const s = String(src || "");
  if (s.length > 400) throw new Error("Formula too long (400 characters max).");
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) { const m = s.slice(i).match(/^\d*\.?\d+(e[+-]?\d+)?/i); if (!m) throw new Error(`Bad number at ${i + 1}`); out.push({ t: "num", v: parseFloat(m[0]) }); i += m[0].length; continue; }
    if (/[A-Za-z_]/.test(c)) { const m = s.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/); out.push({ t: "id", v: m[0] }); i += m[0].length; continue; }
    if ("+-*/(),^".includes(c)) { out.push({ t: c }); i++; continue; }
    throw new Error(`Unexpected "${c}" in formula`);
  }
  return out;
}

// Recursive descent → AST: {num} {var} {op,a,b} {neg} {call,name,args}
function parse(src) {
  const tk = tokenize(src); let p = 0;
  const peek = () => tk[p], eat = (t) => { if (tk[p]?.t !== t) throw new Error(`Expected "${t}"`); return tk[p++]; };
  function expr() { let a = term(); while (peek()?.t === "+" || peek()?.t === "-") { const op = tk[p++].t; a = { op, a, b: term() }; } return a; }
  function term() { let a = power(); while (peek()?.t === "*" || peek()?.t === "/") { const op = tk[p++].t; a = { op, a, b: power() }; } return a; }
  function power() { const a = unary(); if (peek()?.t === "^") { p++; return { op: "^", a, b: power() }; } return a; }
  function unary() { if (peek()?.t === "-") { p++; return { neg: unary() }; } if (peek()?.t === "+") { p++; return unary(); } return atom(); }
  function atom() {
    const x = peek(); if (!x) throw new Error("Formula ends early");
    if (x.t === "num") { p++; return { num: x.v }; }
    if (x.t === "(") { p++; const e = expr(); eat(")"); return e; }
    if (x.t === "id") {
      p++;
      if (peek()?.t !== "(") return { var: x.v };
      p++; const args = [];
      if (peek()?.t !== ")") { args.push(expr()); while (peek()?.t === ",") { p++; args.push(expr()); } }
      eat(")");
      const name = x.v.toLowerCase();
      if (ROLLING.includes(name)) {
        if (!args[0]?.var) throw new Error(`${name}() takes a metric key first, e.g. ${name}(hrv, 7)`);
        const n = args[1]?.num ?? (name === "prev" ? 1 : 7);
        if (!(n >= 1 && n <= 365)) throw new Error(`${name}(): days must be 1–365`);
        return { call: name, metric: args[0].var, n };
      }
      if (FUNCS1[name] && args.length === 1) return { call: name, args };
      if (FUNCSN[name] && args.length >= 2) return { call: name, args };
      if (name === "if" && args.length === 3) return { call: "if", args };
      throw new Error(`Unknown function ${x.v}() — use ${[...Object.keys(FUNCS1), ...Object.keys(FUNCSN), ...ROLLING, "if"].join(", ")}`);
    }
    throw new Error(`Unexpected "${x.t}"`);
  }
  const ast = expr(); if (p < tk.length) throw new Error(`Unexpected "${tk[p].v ?? tk[p].t}"`);
  return ast;
}

function variables(ast, out = new Set()) {
  if (!ast) return out;
  if (ast.var) out.add(ast.var);
  if (ast.metric) out.add(ast.metric);
  for (const k of ["a", "b", "neg"]) if (ast[k]) variables(ast[k], out);
  for (const a of ast.args || []) variables(a, out);
  return out;
}

// days: sorted [{_dateKey, key: number…}]; returns [{date, value}] for days where the formula has every input
function evaluate(src, days) {
  const ast = typeof src === "string" ? parse(src) : src;
  const series = {};   // metric → [values by day index] for rolling lookups
  const col = (k) => series[k] ||= days.map(d => (typeof d[k] === "number" && isFinite(d[k]) ? d[k] : null));
  const window = (k, i, n) => col(k).slice(Math.max(0, i - n + 1), i + 1).filter(v => v != null);
  function ev(a, i) {
    if (a.num != null) return a.num;
    if (a.var) { const v = col(a.var)[i]; if (v == null) throw MISSING; return v; }
    if (a.neg) return -ev(a.neg, i);
    if (a.op) { const x = ev(a.a, i), y = ev(a.b, i);
      if (a.op === "+") return x + y; if (a.op === "-") return x - y; if (a.op === "*") return x * y;
      if (a.op === "/") { if (y === 0) throw MISSING; return x / y; } return Math.pow(x, y); }
    if (a.call === "if") return ev(a.args[0], i) > 0 ? ev(a.args[1], i) : ev(a.args[2], i);
    if (FUNCS1[a.call]) return FUNCS1[a.call](ev(a.args[0], i));
    if (FUNCSN[a.call]) return FUNCSN[a.call](...a.args.map(x => ev(x, i)));
    const w = window(a.metric, i, a.n);
    switch (a.call) {
      case "avg": if (!w.length) throw MISSING; return w.reduce((s, v) => s + v, 0) / w.length;
      case "sum": return w.reduce((s, v) => s + v, 0);
      case "count": return w.length;
      case "min7": if (!w.length) throw MISSING; return Math.min(...w);
      case "max7": if (!w.length) throw MISSING; return Math.max(...w);
      case "prev": { const c = col(a.metric); for (let j = i - a.n; j >= 0; j--) if (c[j] != null) return c[j]; throw MISSING; }
      case "delta": case "pct_change": {
        const c = col(a.metric), now = c[i]; if (now == null) throw MISSING;
        const back = window(a.metric, i - 1, a.n)[0]; if (back == null || (a.call === "pct_change" && back === 0)) throw MISSING;
        return a.call === "delta" ? now - back : (now - back) / Math.abs(back) * 100;
      }
    }
    throw new Error("bad node");
  }
  const MISSING = new Error("missing");
  const out = [];
  for (let i = 0; i < days.length; i++) {
    try { const v = ev(ast, i); if (isFinite(v)) out.push({ date: days[i]._dateKey, value: Math.round(v * 1000) / 1000 }); }
    catch (e) { if (e !== MISSING) throw e; }
  }
  return out;
}

module.exports = { parse, evaluate, variables, ROLLING };
