// Run with: node --test web/tests
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";

const require = createRequire(import.meta.url);
const E = require("../engine.js");
const load = () => E.prepare(JSON.parse(readFileSync(new URL("../../data/dataset.json", import.meta.url), "utf8")));

const baseOpts = (model, extra = {}) => ({
  status: {}, target: 30, maxE: 33, early: "09:00", late: "21:00", off: [], w: {...E.PRESETS.balanced},
  auto: true, lang: "English", timeBudgetMs: 4000, ...extra,
});
const byName = (model, re) => model.courses.find((c) => re.test(c.n) && c.l.includes("English") && c.e === 6);

// ---- tiny synthetic catalogue: exact expectations -------------------------------------------------
function tinyModel() {
  const cal = {first_monday: 24, break_week: 9, calendar_weeks: 15, teaching_weeks: 14};
  const term = [[24, 130]];
  const course = (id, name, e, groups, extra = {}) => ({id, n: name, es: name, fam: name, e, l: ["English"], y: [3], dg: [], codes: [],
    m: 2, h: 3, a: 3, ex: 40, skills: false, groups: groups.map((s, i) => ({g: String(i), deg: [], code: [], s})), ...extra});
  const lec = (day, start, end) => [day, start, end, "T", term, ""];
  return E.prepare({calendar: cal, courses: [
    course(0, "A", 6, [[lec(0, 540, 630), lec(2, 540, 630)]]),
    course(1, "B", 6, [[lec(0, 540, 630)], [lec(1, 540, 630), lec(3, 540, 630)]]),   // group 0 clashes with A
    course(2, "C", 6, [[lec(1, 645, 735), lec(3, 645, 735)]]),
    course(3, "D", 6, [[lec(4, 540, 630)]]),
    course(4, "E", 6, [[lec(2, 645, 735)]]),
  ]});
}

test("clash detection respects day, time and weeks", () => {
  const m = tinyModel();
  assert.equal(E.groupsClash(m.courses[0].groups[0], m.courses[1].groups[0]), true);
  assert.equal(E.groupsClash(m.courses[0].groups[0], m.courses[1].groups[1]), false);
});

test("metrics: days off, hours and gaps", () => {
  const m = tinyModel();
  const plan = [{c: m.courses[1], g: m.courses[1].groups[1], s: "want"}, {c: m.courses[2], g: m.courses[2].groups[0], s: "want"}];
  const mt = E.metrics(m, plan, {wantTotal: 2});
  assert.deepEqual(mt.off, [0, 2, 4]);
  assert.equal(mt.offAvg, 3);
  assert.equal(mt.gapHrs, 0, "09:00-10:30 then 10:45 is a normal changeover, not a gap");
  assert.ok(Math.abs(mt.hrs - 6) < 1e-9);
  assert.equal(mt.vals.prefs, 1);
});

test("solver: never returns clashing groups and honours the target", () => {
  const m = tinyModel();
  const res = E.solve(m, {...baseOpts(m), target: 18, maxE: 18, auto: false, status: {0: "want", 1: "want", 2: "want", 3: "backup", 4: "backup"}});
  assert.ok(res.plans.length > 0);
  for (const p of res.plans) {
    const picked = E.hydrate(m, p);
    assert.equal(picked.reduce((a, x) => a + x.c.e, 0), 18);
    for (let i = 0; i < picked.length; i++) for (let j = i + 1; j < picked.length; j++) {
      assert.equal(E.groupsClash(picked[i].g, picked[j].g), false);
    }
  }
});

test("solver: Must courses are always included", () => {
  const m = tinyModel();
  const res = E.solve(m, {...baseOpts(m), target: 12, maxE: 12, auto: false, status: {3: "must", 0: "want", 2: "want", 4: "backup"}});
  for (const p of res.plans) assert.ok(p.items.some((x) => x.id === 3));
});

test("solver: free-day constraint removes every group on that day", () => {
  const m = tinyModel();
  const res = E.solve(m, {...baseOpts(m), target: 12, maxE: 12, auto: false, off: [0], status: {0: "want", 1: "want", 2: "want", 3: "want", 4: "want"}});
  for (const p of res.plans) for (const x of E.hydrate(m, p)) assert.ok(!x.g.days.has(0));
});

// ---- real catalogue -------------------------------------------------------------------------------
test("real data: optimiser matches brute force on a shortlist", () => {
  const m = load();
  const ids = [/^Mobile Applications/, /^Artificial Intelligence/, /^Software Engineering of Artificial/, /^Introduction to engineering management/,
    /^Machine Learning$/i, /^Operating Systems/].map((re) => byName(m, re)).filter(Boolean).map((c) => c.id);
  assert.ok(ids.length >= 5, "shortlist courses exist in the dataset");
  const status = Object.fromEntries(ids.map((id) => [id, "want"]));
  const opts = baseOpts(m, {status, auto: false});
  const res = E.solve(m, opts);
  assert.ok(res.stats.complete);

  const mopts = {...opts, wantTotal: res.stats.wantTotal};
  let best = -Infinity;
  const courses = ids.map((id) => m.courses[id]);
  (function rec(i, picked, e) {
    if (e >= opts.target) { best = Math.max(best, E.score(E.metrics(m, picked, mopts), mopts)); return; }
    if (i >= courses.length) return;
    const c = courses[i];
    if (e + c.e <= opts.maxE) for (const g of c.groups) if (E.groupAllowed(g, opts) && E.fitsWith(g, picked)) rec(i + 1, [...picked, {c, g, s: "want"}], e + c.e);
    rec(i + 1, picked, e);
  })(0, [], 0);
  assert.ok(Math.abs(res.plans[0].score - best) < 1e-9, `optimiser ${res.plans[0].score} vs brute force ${best}`);
});

test("real data: auto-fill finishes within budget and skips skills courses", () => {
  const m = load();
  const status = {[byName(m, /^Mobile Applications/).id]: "want", [byName(m, /^Artificial Intelligence/).id]: "want"};
  const res = E.solve(m, baseOpts(m, {status, timeBudgetMs: 3000}));
  assert.ok(res.stats.ms < 4500, `took ${res.stats.ms} ms`);
  assert.ok(res.plans.length === 3);
  const mopts = {...baseOpts(m, {status}), wantTotal: res.stats.wantTotal};
  for (const p of res.plans) {
    const picked = E.hydrate(m, p);
    assert.ok(Math.abs(p.score - E.score(E.metrics(m, picked, mopts), mopts)) < 1e-9, "incremental score equals the reference metrics");
    assert.ok(picked.every((x) => !x.c.skills || x.s !== "auto"));
    assert.equal(new Set(picked.map((x) => x.c.fam)).size, picked.length, "no course twice");
    assert.ok(picked.every((x) => !x.g.l.length || x.g.l.includes("English")), "only groups of English-taught variants");
  }
});

test("real data: fallbacks never clash with the rest of the plan", () => {
  const m = load();
  const status = {[byName(m, /^Mobile Applications/).id]: "want", [byName(m, /^Artificial Intelligence/).id]: "want"};
  const opts = baseOpts(m, {status});
  const res = E.solve(m, opts);
  const picked = E.hydrate(m, res.plans[0]);
  const mopts = {...opts, wantTotal: res.stats.wantTotal};
  for (let k = 0; k < picked.length; k++) {
    const rest = picked.filter((_, i) => i !== k);
    const fb = E.fallbacks(m, picked, k, mopts);
    for (const a of fb.alts) assert.ok(E.fitsWith(a.g, rest));
    for (const o of fb.otherGroups) assert.ok(E.fitsWith(o.g, rest));
  }
});
