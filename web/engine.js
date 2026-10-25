/*
 * Planner engine: the scoring model and the optimiser.
 * Pure functions, no DOM: the same file runs in the page, inside a Web Worker and under `node --test`.
 *
 * Vocabulary
 *   course  one entry of dataset.courses (merged across degrees)
 *   group   one teaching group of a course; s = [[day, start, end, kind, [[fromDay, toDay], ...], rooms], ...]
 *   slot    key week * 8 + weekday; a group's slots map holds its [start, end] intervals for that day of that week
 *   plan    [{c, g, s}] with s = "must" | "want" | "backup" | "auto"
 */
(function (root) {
  "use strict";

  const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const CRITERIA = [
    {k: "ai", label: "AI & software", desc: "AI, data, software and app topics"},
    {k: "hands", label: "Hands-on", desc: "labs, projects and continuous work"},
    {k: "maths", label: "Maths load", desc: "lighter maths and lower course year score higher"},
    {k: "exam", label: "Continuous assessment", desc: "less of the grade riding on the final exam"},
    {k: "days", label: "Compact week", desc: "weekdays without class, averaged over the semester"},
    {k: "hours", label: "Contact hours", desc: "fewer hours in class per week"},
    {k: "gaps", label: "No dead time", desc: "idle time between classes on campus days"},
    {k: "load", label: "Fewer courses", desc: "fewer separate courses for the same ECTS"},
    {k: "prefs", label: "Your picks", desc: "share of your Want courses included"},
  ];
  const PRESETS = {
    balanced: {ai: 4, hands: 3, maths: 3, exam: 2, days: 3, hours: 3, gaps: 3, load: 2, prefs: 4},
    focus:    {ai: 5, hands: 4, maths: 3, exam: 2, days: 1, hours: 1, gaps: 1, load: 1, prefs: 4},
    compact:  {ai: 2, hands: 2, maths: 3, exam: 2, days: 5, hours: 4, gaps: 4, load: 3, prefs: 3},
  };
  const COURSE_CRITERIA = ["ai", "hands", "maths", "exam", "hours"];
  const EXCESS_PENALTY = 1.5;   // score points per ECTS above the target
  const CHANGEOVER = 15;        // minutes between consecutive slots that don't count as a gap
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const toMin = (t) => { const [h, m] = String(t).split(":").map(Number); return h * 60 + m; };

  // ---------------------------------------------------------------- preparation
  function prepare(dataset) {
    const cal = dataset.calendar;
    const teach = cal.teaching_weeks;
    const weekOf = (day) => Math.floor((day - cal.first_monday) / 7) + 1;
    const sessionWeeks = (row) => {
      const out = new Set();
      for (const [a, b] of row[4]) for (let d = a; d <= b; d += 7) {
        const w = weekOf(d);
        if (w >= 1 && w <= cal.calendar_weeks && w !== cal.break_week) out.add(w);
      }
      return [...out].sort((x, y) => x - y);
    };
    for (const c of dataset.courses) {
      const year = Math.min(...(c.y.length ? c.y : [2]));
      c.diff = 0.75 * c.m + 0.25 * (1 + (year - 1) * 4 / 3);
      for (const g of c.groups) {
        let minutes = 0;
        g.slots = new Map(); g.days = new Set(); g.weeks = [];
        for (const row of g.s) {
          const wks = sessionWeeks(row);
          g.weeks.push(wks);
          minutes += (row[2] - row[1]) * wks.length;
          g.days.add(row[0]);
          for (const w of wks) {
            const key = w * 8 + row[0];
            if (!g.slots.has(key)) g.slots.set(key, []);
            g.slots.get(key).push([row[1], row[2]]);
          }
        }
        g.hrs = minutes / 60 / teach;
        encodeMasks(g);
        const daysPerWeekday = [0, 0, 0, 0, 0, 0];
        for (const key of g.slots.keys()) daysPerWeekday[key % 8]++;
        g.weekly = new Set([...g.days].filter((d) => daysPerWeekday[d] >= teach / 2));
      }
      c.hrs = Math.min(...c.groups.map((g) => g.hrs));
      c.v = courseValues(c);
    }
    return {dataset, cal, teach, courses: dataset.courses, weekOf, sessionWeeks};
  }

  // Each week-day slot as a 64-bit mask of 15-minute bins from 07:00 (two uint32 halves).
  // Lets the optimiser test clashes with AND and count idle time with a bit scan.
  const BIN0 = 7 * 60, BIN = 15, SLOTS = 8 * 20;
  function encodeMasks(g) {
    const keys = [...g.slots.keys()];
    g.keys = Int32Array.from(keys);
    g.lo = new Uint32Array(keys.length); g.hi = new Uint32Array(keys.length);
    keys.forEach((key, i) => {
      for (const [start, end] of g.slots.get(key)) {
        const from = Math.max(0, Math.floor((start - BIN0) / BIN)), to = Math.min(64, Math.ceil((end - BIN0) / BIN));
        for (let b = from; b < to; b++) { if (b < 32) g.lo[i] |= 1 << b; else g.hi[i] |= 1 << (b - 32); }
      }
    });
  }
  // Idle minutes in one slot mask, in O(1): inside the occupied span, each run of empty bins costs
  // (run length - 1) bins because the first 15 minutes are the normal changeover. That sum equals
  // (empty bins in the span) - (number of empty runs) = (span - ones) - (1->0 transitions - 1).
  const pop32 = (x) => {
    x -= (x >>> 1) & 0x55555555;
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  };
  const ctz32 = (x) => 31 - Math.clz32(x & -x);
  function maskIdle(lo, hi) {
    const ones = pop32(lo) + pop32(hi);
    if (ones < 2) return 0;
    const low = lo ? ctz32(lo) : 32 + ctz32(hi);
    const high = hi ? 63 - Math.clz32(hi) : 31 - Math.clz32(lo);
    const shLo = ((lo >>> 1) | ((hi & 1) << 31)) >>> 0, shHi = hi >>> 1;
    const ends = pop32((lo & ~shLo) >>> 0) + pop32((hi & ~shHi) >>> 0);   // last bin of each class block
    return ((high - low + 1 - ones) - (ends - 1)) * BIN;
  }

  // per-course criterion values in [0, 1]; a missing exam share counts as 50 %
  function courseValues(c) {
    return {
      ai: clamp01((c.a - 1) / 4),
      hands: clamp01((c.h - 1) / 4),
      maths: clamp01((5 - c.diff) / 4),
      exam: clamp01(1 - (c.ex ?? 50) / 70),
      hours: clamp01((0.8 - c.hrs / c.e) / 0.5),
    };
  }

  function courseMatch(c, w) {
    const total = COURSE_CRITERIA.reduce((a, k) => a + w[k], 0) || 1;
    return Math.round(COURSE_CRITERIA.reduce((a, k) => a + w[k] * c.v[k], 0) / total * 100);
  }

  // hours window, free weekdays and, when a language is set, groups taught for a degree offered in it
  const groupAllowed = (g, opts) => {
    if (opts.lang && g.l && g.l.length && !g.l.includes(opts.lang)) return false;
    const early = toMin(opts.early), late = toMin(opts.late);
    return g.s.every((r) => r[1] >= early && r[2] <= late && !opts.off.includes(r[0]));
  };

  const overlaps = (list, [start, end]) => list.some(([a, b]) => start < b && a < end);

  function groupsClash(g, h) {
    const [small, big] = g.slots.size <= h.slots.size ? [g, h] : [h, g];
    for (const [key, ivs] of small.slots) {
      const other = big.slots.get(key);
      if (other && ivs.some((iv) => overlaps(other, iv))) return true;
    }
    return false;
  }
  const fitsWith = (g, picked) => picked.every((p) => !groupsClash(g, p.g));

  // ---------------------------------------------------------------- metrics and score
  function metrics(model, picked, opts) {
    const teach = model.teach;
    const byKey = new Map();
    for (const p of picked) for (const [key, ivs] of p.g.slots) {
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(...ivs);
    }
    let busy = 0, gapMin = 0;
    for (const [key, ivs] of byKey) {
      if (key % 8 < 5) busy++;
      ivs.sort((a, b) => a[0] - b[0]);
      let end = ivs[0][1];
      for (let i = 1; i < ivs.length; i++) { gapMin += Math.max(0, ivs[i][0] - end - CHANGEOVER); end = Math.max(end, ivs[i][1]); }
    }
    const days = new Set(), weekly = new Set();
    const sums = {ai: 0, hands: 0, maths: 0, exam: 0};
    let hrs = 0, e = 0, wants = 0, exPct = 0, exE = 0, m = 0, a = 0;
    for (const p of picked) {
      p.g.days.forEach((d) => days.add(d)); p.g.weekly.forEach((d) => weekly.add(d));
      hrs += p.g.hrs; e += p.c.e;
      if (p.s === "want") wants++;
      for (const k in sums) sums[k] += p.c.v[k] * p.c.e;
      if (p.c.ex != null) { exPct += p.c.ex * p.c.e; exE += p.c.e; }
      m += p.c.m * p.c.e; a += p.c.a * p.c.e;
    }
    const wantTotal = opts.wantTotal ?? 0;
    const offAvg = 5 - busy / teach;
    const n = picked.length;
    return {
      e, n, hrs, wants, offAvg, gapHrs: gapMin / 60 / teach,
      off: [0, 1, 2, 3, 4].filter((d) => !days.has(d)),
      occasional: [0, 1, 2, 3, 4].filter((d) => days.has(d) && !weekly.has(d)),
      exam: exE ? exPct / exE : null, maths: e ? m / e : 0, ai: e ? a / e : 0,
      vals: {
        ai: e ? sums.ai / e : 0, hands: e ? sums.hands / e : 0, maths: e ? sums.maths / e : 0, exam: e ? sums.exam / e : 0,
        days: clamp01(offAvg / 3), hours: clamp01((24 - hrs) / 14), gaps: clamp01(1 - gapMin / 60 / teach / 6),
        load: clamp01((8 - n) / 3), prefs: wantTotal ? clamp01(wants / wantTotal) : 1,
      },
    };
  }

  const weightSum = (w) => CRITERIA.reduce((acc, c) => acc + w[c.k], 0) || 1;
  function score(mt, opts) {
    const base = CRITERIA.reduce((acc, c) => acc + opts.w[c.k] * mt.vals[c.k], 0) / weightSum(opts.w) * 100;
    return base - Math.max(0, mt.e - opts.target) * EXCESS_PENALTY;
  }

  // ---------------------------------------------------------------- optimiser
  /**
   * Depth-first branch and bound over (course, group) choices.
   * Hard constraints: ECTS in [target, max], Must courses, the hours window and free days, no clashes,
   * at most one variant of the same course. The bound is optimistic per criterion, so pruning never
   * drops a plan that could beat the current third-best; when the time budget runs out the search
   * stops early and reports it.
   */
  function solve(model, opts) {
    const t0 = Date.now();
    const budget = opts.timeBudgetMs ?? 2000;
    const K = opts.k ?? 3;
    const T = opts.target, MX = Math.max(opts.maxE, T);
    const status = opts.status || {};
    const w = opts.w;
    const wantTotal = Object.entries(status).filter(([id, s]) => s === "want" && model.courses[id]
      && model.courses[id].groups.some((g) => groupAllowed(g, opts))).length;
    const mopts = {...opts, wantTotal};

    const shortlisted = Object.entries(status).filter(([id]) => model.courses[id]).map(([id, s]) => ({c: model.courses[id], s}));
    const takenFams = new Set(shortlisted.map((x) => x.c.fam));
    const auto = !opts.auto ? [] : model.courses
      .filter((c) => !status[c.id] && !c.skills && !takenFams.has(c.fam) && (!opts.lang || c.l.includes(opts.lang))
        && c.groups.some((g) => groupAllowed(g, opts)))
      .sort((x, y) => courseMatch(y, w) - courseMatch(x, w)).slice(0, opts.autoCount ?? 18)
      .map((c) => ({c, s: "auto"}));
    const rank = {must: 0, want: 1, backup: 2, auto: 3};
    const cands = [...shortlisted, ...auto]
      .map((x) => ({...x, gs: x.c.groups.filter((g) => groupAllowed(g, opts)).sort((a, b) => a.days.size - b.days.size || a.hrs - b.hrs)}))
      .sort((x, y) => rank[x.s] - rank[y.s] || courseMatch(y.c, w) - courseMatch(x.c, w));
    const problems = cands.filter((x) => x.s === "must" && !x.gs.length).map((x) => `No group of “${x.c.n}” fits your hours and free days.`);
    const usable = cands.filter((x) => x.gs.length);
    const n = usable.length;

    // suffix bests for the bound
    const best = Array.from({length: n + 1}, () => ({ai: 0, hands: 0, maths: 0, exam: 0, hpe: Infinity, maxE: 0, wants: 0}));
    for (let i = n - 1; i >= 0; i--) {
      const c = usable[i].c, b = best[i], nb = best[i + 1];
      for (const k of ["ai", "hands", "maths", "exam"]) b[k] = Math.max(nb[k], c.v[k]);
      b.hpe = Math.min(nb.hpe, Math.min(...usable[i].gs.map((g) => g.hrs)) / c.e);
      b.maxE = Math.max(nb.maxE, c.e);
      b.wants = nb.wants + (usable[i].s === "want" ? 1 : 0);
    }
    const W = weightSum(w);

    // incremental search state: one 64-bit mask per week-day slot, plus each slot's idle minutes
    const occLo = new Uint32Array(SLOTS), occHi = new Uint32Array(SLOTS), slotIdle = new Float64Array(SLOTS);
    const picked = [];
    const fams = new Set();
    let busy = 0, hrs = 0, gapTotal = 0, wants = 0;
    const sums = {ai: 0, hands: 0, maths: 0, exam: 0};
    const found = new Map();
    let nodes = 0, aborted = false;

    const fits = (g) => {
      const {keys, lo, hi} = g;
      for (let i = 0; i < keys.length; i++) if ((occLo[keys[i]] & lo[i]) | (occHi[keys[i]] & hi[i])) return false;
      return true;
    };
    const touch = (key, lo, hi) => {
      const wasBusy = (occLo[key] | occHi[key]) !== 0;
      occLo[key] = lo; occHi[key] = hi;
      const isBusy = (lo | hi) !== 0;
      if (key % 8 < 5 && wasBusy !== isBusy) busy += isBusy ? 1 : -1;
      const idle = isBusy ? maskIdle(lo, hi) : 0;
      gapTotal += idle - slotIdle[key];
      slotIdle[key] = idle;
    };
    const add = (x, g) => {
      const {keys, lo, hi} = g;
      for (let i = 0; i < keys.length; i++) touch(keys[i], occLo[keys[i]] | lo[i], occHi[keys[i]] | hi[i]);
      picked.push({c: x.c, g, s: x.s}); fams.add(x.c.fam); hrs += g.hrs;
      if (x.s === "want") wants++;
      for (const k in sums) sums[k] += x.c.v[k] * x.c.e;
    };
    const remove = (x, g) => {
      const {keys, lo, hi} = g;
      for (let i = 0; i < keys.length; i++) touch(keys[i], occLo[keys[i]] & ~lo[i], occHi[keys[i]] & ~hi[i]);
      picked.pop(); fams.delete(x.c.fam); hrs -= g.hrs;
      if (x.s === "want") wants--;
      for (const k in sums) sums[k] -= x.c.v[k] * x.c.e;
    };
    // found keeps at most a few dozen course sets; threshold = K-th best score, refreshed on insert
    let threshold = -Infinity;
    const record = (key, sc) => {
      const prev = found.get(key);
      if (prev ? prev.score >= sc : sc <= threshold) return;
      found.set(key, {score: sc, items: picked.map((p) => ({id: p.c.id, gi: p.c.groups.indexOf(p.g), s: p.s}))});
      const ranked = [...found.entries()].sort((a, b) => b[1].score - a[1].score);
      if (ranked.length > 4 * K) for (const [k] of ranked.slice(4 * K)) found.delete(k);
      if (ranked.length >= K) threshold = ranked[K - 1][1].score;
    };
    const weighted = (v) => {
      let acc = 0;
      for (const c of CRITERIA) acc += w[c.k] * v[c.k];
      return acc / W * 100;
    };
    // optimistic score of any completion of the current partial plan
    const bound = (i, e) => {
      const rem = Math.max(0, T - e), b = best[i], tot = e + rem || 1;
      const opt = (k) => (sums[k] + b[k] * rem) / tot;
      const extra = rem > 0 && b.maxE ? Math.ceil(rem / b.maxE) : 0;
      return weighted({
        ai: opt("ai"), hands: opt("hands"), maths: opt("maths"), exam: opt("exam"),
        days: clamp01((5 - busy / model.teach) / 3),
        hours: clamp01((24 - (hrs + rem * (isFinite(b.hpe) ? b.hpe : 0))) / 14),
        gaps: 1, load: clamp01((8 - picked.length - extra) / 3),
        prefs: wantTotal ? clamp01((wants + b.wants) / wantTotal) : 1,
      });
    };
    // same value as score(metrics(...)), read from the incremental state (a test checks they agree)
    const leafScore = (e) => weighted({
      ai: sums.ai / e, hands: sums.hands / e, maths: sums.maths / e, exam: sums.exam / e,
      days: clamp01((5 - busy / model.teach) / 3), hours: clamp01((24 - hrs) / 14),
      gaps: clamp01(1 - gapTotal / 60 / model.teach / 6), load: clamp01((8 - picked.length) / 3),
      prefs: wantTotal ? clamp01(wants / wantTotal) : 1,
    }) - Math.max(0, e - T) * EXCESS_PENALTY;

    function dfs(i, e) {
      if (aborted) return;
      if ((++nodes & 1023) === 0 && Date.now() - t0 > budget) { aborted = true; return; }
      if (e >= T) {
        const sc = leafScore(e);
        if (sc > threshold || found.size < K) record(picked.map((p) => p.c.id).sort((a, b) => a - b).join(","), sc);
        return;
      }
      if (i >= n || bound(i, e) <= threshold) return;
      const x = usable[i];
      if (e + x.c.e <= MX && !fams.has(x.c.fam)) {
        for (const g of x.gs) if (fits(g)) { add(x, g); dfs(i + 1, e + x.c.e); remove(x, g); if (aborted) return; }
      }
      if (x.s !== "must") dfs(i + 1, e);
    }

    dfs(0, 0);
    if (!found.size && usable.some((x) => x.s === "must")) {
      problems.push("Your Must courses can't all fit together under these constraints; showing the closest plans.");
      usable.forEach((x) => { if (x.s === "must") x.s = "want"; });
      aborted = false; dfs(0, 0);
    }
    const plans = [...found.values()].sort((a, b) => b.score - a.score).slice(0, K);
    return {plans, problems, stats: {nodes, ms: Date.now() - t0, complete: !aborted, candidates: n, wantTotal}};
  }

  // Rehydrate a plan returned by solve() (it only carries ids, so it can cross the worker boundary).
  function hydrate(model, plan) {
    return plan.items.map((x) => ({c: model.courses[x.id], g: model.courses[x.id].groups[x.gi], s: x.s}));
  }

  // ---------------------------------------------------------------- fallbacks
  /** Ways to replace course k: other groups, then other courses, ranked by the whole plan's score after the swap. */
  function fallbacks(model, picked, k, opts) {
    const rest = picked.filter((_, i) => i !== k), me = picked[k];
    const restE = rest.reduce((a, p) => a + p.c.e, 0);
    const fams = new Set(rest.map((p) => p.c.fam));
    const evalWith = (c, g, s) => {
      const mt = metrics(model, [...rest, {c, g, s}], opts);
      return {score: score(mt, opts), reaches: mt.e >= opts.target};
    };
    const otherGroups = me.c.groups
      .filter((g) => g !== me.g && groupAllowed(g, opts) && fitsWith(g, rest))
      .map((g) => ({g, ...evalWith(me.c, g, me.s)})).sort((a, b) => b.score - a.score);
    const status = opts.status || {};
    const pool = [
      ...Object.keys(status).map((id) => model.courses[id]).filter(Boolean),
      ...model.courses.filter((c) => !status[c.id] && !c.skills && (!opts.lang || c.l.includes(opts.lang)))
        .sort((x, y) => courseMatch(y, opts.w) - courseMatch(x, opts.w)).slice(0, 30),
    ];
    const alts = [];
    for (const c of pool) {
      if (c.id === me.c.id || fams.has(c.fam) || alts.some((a) => a.c.id === c.id) || restE + c.e > Math.max(opts.maxE, opts.target)) continue;
      let top = null;
      for (const g of c.groups) if (groupAllowed(g, opts) && fitsWith(g, rest)) {
        const r = evalWith(c, g, status[c.id] || "auto");
        if (!top || r.score > top.score) top = {c, g, ...r, src: status[c.id] || "catalog"};
      }
      if (top) alts.push(top);
    }
    alts.sort((a, b) => b.reaches - a.reaches || b.score - a.score);
    return {otherGroups, alts: alts.slice(0, 3)};
  }

  /** How many courses of a plan have a fallback that keeps the plan complete and within `slack` points. */
  function robustness(model, picked, opts, planScore, slack = 8) {
    let covered = 0;
    const perCourse = picked.map((_, k) => {
      const fb = fallbacks(model, picked, k, opts);
      const bestScore = Math.max(-Infinity, ...fb.otherGroups.map((o) => o.score), ...fb.alts.filter((a) => a.reaches).map((a) => a.score));
      const ok = bestScore >= planScore - slack;
      if (ok) covered++;
      return {fb, ok};
    });
    return {covered, total: picked.length, perCourse};
  }

  const api = {DAYS, CRITERIA, PRESETS, COURSE_CRITERIA, EXCESS_PENALTY, prepare, courseMatch, groupAllowed, groupsClash,
    fitsWith, metrics, score, solve, hydrate, fallbacks, robustness, toMin};
  root.PlannerEngine = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
