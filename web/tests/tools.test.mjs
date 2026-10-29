// Run with: node --test web/tests/
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";

const require = createRequire(import.meta.url);
const E = require("../engine.js");
const T = require("../tools.js");

function fakeApi() {
  const model = E.prepare(JSON.parse(readFileSync(new URL("../../data/dataset.json", import.meta.url), "utf8")));
  const state = {status: {}, w: {...E.PRESETS.balanced}, target: 30, maxE: 33, early: "09:00", late: "21:00", off: [], lang: "English", auto: true};
  let plans = [];
  return {
    model, state,
    getState: () => state,
    getPlans: () => plans,
    setStatus: (id, s) => { if (s) state.status[id] = s; else delete state.status[id]; },
    setWeights: (w) => Object.assign(state.w, w),
    setConstraints: (c) => Object.assign(state, c),
    async build() {
      const r = E.solve(model, {...state, timeBudgetMs: 4000});
      const mopts = {...state, wantTotal: r.stats.wantTotal};
      plans = r.plans.map((p) => {
        const picked = E.hydrate(model, p);
        const mt = E.metrics(model, picked, mopts);
        return {picked, e: mt.e, score: p.score, mt, robust: E.robustness(model, picked, mopts, p.score)};
      });
      return {plans, stats: r.stats, problems: r.problems};
    },
  };
}

test("search_courses ranks by query and honours filters", async () => {
  const api = fakeApi();
  const tools = T.createTools(api, E);
  const res = await tools.run("search_courses", {query: "machine learning", max_maths: 4, limit: 5});
  assert.ok(res.courses.length > 0 && res.courses.length <= 5);
  assert.ok(/machine learning/i.test(res.courses[0].name), res.courses[0].name);
  for (const c of res.courses) {
    assert.ok(c.scores.maths <= 4);
    assert.ok(c.languages.includes("English"));
    assert.ok(!c.skills_course);
  }
});

test("update_shortlist applies valid changes and reports bad ones", async () => {
  const api = fakeApi();
  const tools = T.createTools(api, E);
  const res = await tools.run("update_shortlist", {changes: [{id: 0, status: "want"}, {id: 99999, status: "want"}, {id: 1, status: "maybe"}]});
  assert.equal(res.applied.length, 1);
  assert.equal(res.rejected.length, 2);
  assert.equal(api.state.status[0], "want");
  await tools.run("update_shortlist", {changes: [{id: 0, status: "remove"}]});
  assert.equal(api.state.status[0], undefined);
});

test("set_preferences clamps weights and parses constraints", async () => {
  const api = fakeApi();
  const tools = T.createTools(api, E);
  await tools.run("set_preferences", {weights: {ai: 9, maths: -2, bogus: 3}, target_ects: 24, free_days: ["Fri", "Sun"], earliest_start: "10:00"});
  assert.equal(api.state.w.ai, 5);
  assert.equal(api.state.w.maths, 0);
  assert.equal(api.state.w.bogus, undefined);
  assert.equal(api.state.target, 24);
  assert.deepEqual(api.state.off, [4]);
  assert.equal(api.state.early, "10:00");
});

test("build_plans returns valid summaries the model can read", async () => {
  const api = fakeApi();
  const tools = T.createTools(api, E);
  const res = await tools.run("build_plans", {});
  assert.ok(res.plans.length > 0);
  const p = res.plans[0];
  assert.ok(p.ects >= 30 && p.courses.length === p.courses_count);
  assert.ok(p.courses.every((c) => typeof c.code === "string" && c.days.length));
});

test("get_course returns details or a helpful error", async () => {
  const api = fakeApi();
  const tools = T.createTools(api, E);
  const ok = await tools.run("get_course", {id: 3});
  assert.equal(ok.id, 3);
  assert.ok(Array.isArray(ok.groups) && ok.groups[0].sessions.length);
  const bad = await tools.run("get_course", {id: -5});
  assert.match(bad.error, /No course/);
  const unknown = await tools.run("drop_database", {});
  assert.match(unknown.error, /Unknown tool/);
});

test("planForMe: AI-minded, maths-averse profile yields relevant low-maths picks", () => {
  const api = fakeApi();
  const out = T.planForMe({topics: ["ai", "software"], maths: "avoid", exams: "continuous", schedule: "balanced", english: true}, api.model, E);
  assert.equal(out.weights.maths, 5);
  assert.equal(out.weights.ai, 5);
  assert.equal(out.shortlist.length, 10);
  assert.equal(out.shortlist.filter((x) => x.status === "want").length, 4);
  const picked = out.shortlist.map((x) => api.model.courses[x.id]);
  assert.ok(picked.every((c) => c.l.includes("English") && !c.skills));
  assert.equal(new Set(picked.map((c) => c.fam)).size, picked.length, "no duplicate course variants");
  const meanMaths = picked.reduce((a, c) => a + c.m, 0) / picked.length;
  assert.ok(meanMaths < 3, `mean maths ${meanMaths}`);
  assert.ok(picked.slice(0, 4).every((c) => T.topicScore(c, ["ai", "software"]) > 0));
});

test("planForMe: time window and free day exclude courses that cannot fit", () => {
  const api = fakeApi();
  const out = T.planForMe({topics: ["software"], maths: "ok", exams: "any", window: "late", dayoff: "fri", english: true}, api.model, E);
  assert.equal(out.early, "10:45");
  assert.deepEqual(out.off, [4]);
  for (const x of out.shortlist) assert.ok(api.model.courses[x.id].groups.some((g) => E.groupAllowed(g, out)), api.model.courses[x.id].n);
});

test("planForMe: swap picks returns different courses", () => {
  const api = fakeApi();
  const answers = {topics: ["ai"], maths: "avoid", exams: "continuous", english: true};
  const first = T.planForMe(answers, api.model, E);
  const second = T.planForMe(answers, api.model, E, {}, new Set(first.shortlist.slice(0, 4).map((x) => x.id)));
  const firstWants = new Set(first.shortlist.slice(0, 4).map((x) => x.id));
  assert.ok(second.shortlist.every((x) => !firstWants.has(x.id)));
});

test("explainPick and the live counter give sensible output", () => {
  const api = fakeApi();
  const mobile = api.model.courses.find((c) => /^Mobile Applications/.test(c.n) && c.e === 6 && c.ex === 0);
  assert.ok(T.explainPick(mobile, ["software"]).includes("no final exam"));
  const all = T.stillInTheRunning({english: false}, api.model, E);
  const narrow = T.stillInTheRunning({topics: ["ai"], maths: "avoid", english: true, window: "late", dayoff: "fri"}, api.model, E);
  assert.ok(all > narrow && narrow > 0, `${all} > ${narrow} > 0`);
});
