/*
 * Advisor tools: the operations an assistant (LLM or the no-key wizard) may perform on the planner.
 * Pure logic over an injected `api`, so the same code runs in the page and under `node --test`.
 *
 *   api = {
 *     model,                     // PlannerEngine.prepare(dataset)
 *     getState(),                // {status, w, target, maxE, early, late, off, lang}
 *     setStatus(id, s | null),   // "must" | "want" | "backup" | null (remove)
 *     setWeights(partialW),
 *     setConstraints(partial),   // {target, maxE, early, late, off}
 *     build(),                   // Promise<{plans: [{picked, e, score, mt, robust}], stats, problems}>
 *   }
 */
(function (root) {
  "use strict";

  const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
  const STATUSES = ["must", "want", "backup"];
  const WEIGHT_KEYS = ["ai", "hands", "maths", "exam", "days", "hours", "gaps", "load", "prefs"];
  const norm = (s) => String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v))));

  // Topic vocabularies used by the wizard and by search ranking (English and Spanish stems).
  const TOPICS = {
    ai: {label: "AI & machine learning", terms: ["artificial intelligence", "inteligencia artificial", "machine learning", "aprendizaje", "neural", "deep learning", "vision", "language model", "agent", "reinforcement"]},
    software: {label: "Software & apps", terms: ["software", "programming", "programacion", "mobile", "app", "web", "development", "desarrollo", "devops", "cloud", "distributed", "operating system"]},
    data: {label: "Data & analytics", terms: ["data", "datos", "database", "statistic", "analytics", "big data", "visualization", "mining"]},
    robotics: {label: "Robotics & automation", terms: ["robot", "automation", "automatic", "control", "mechatron", "sensor", "drone", "manipulat"]},
    networks: {label: "Networks & security", terms: ["network", "redes", "internet", "telematic", "security", "seguridad", "cyber", "protocol", "wireless"]},
    business: {label: "Business & management", terms: ["management", "gestion", "business", "empresa", "economic", "entrepreneur", "product", "marketing", "organization"]},
    energy: {label: "Energy & sustainability", terms: ["energy", "energia", "renewable", "solar", "environment", "sustainab", "power", "electric", "grid"]},
    mechanics: {label: "Aerospace & mechanics", terms: ["aerospace", "aircraft", "mechanic", "mecanica", "fluid", "structur", "propulsion", "vehicle", "thermal"]},
    biomed: {label: "Biomedical", terms: ["biomedic", "medical", "medic", "bio", "health", "clinical", "tissue", "imaging"]},
    signals: {label: "Signals, image & sound", terms: ["signal", "senal", "image", "imagen", "audio", "sound", "sonido", "video", "multimedia", "communication"]},
    theory: {label: "Maths & physics", terms: ["mathemat", "matematic", "physics", "fisica", "algebra", "calculus", "quantum", "optimization", "probability"]},
  };

  const courseText = (c) => norm([c.n, c.es, c.obj, c.cont, c.ins && c.ins.summary, c.ins && (c.ins.learn || []).join(" ")].join(" "));
  function topicScore(c, topicKeys) {
    if (!topicKeys.length) return 0;
    const text = c._text || (c._text = courseText(c));
    let hits = 0;
    for (const k of topicKeys) for (const t of TOPICS[k].terms) if (text.includes(t)) hits += t.length > 6 ? 2 : 1;
    return Math.min(1, hits / 6);
  }
  function queryScore(c, query) {
    const words = norm(query).split(/[^a-z0-9+#]+/).filter((w) => w.length > 1);
    if (!words.length) return 0;
    const name = norm(`${c.n} ${c.es}`), text = c._text || (c._text = courseText(c));
    let s = 0;
    for (const w of words) s += (name.includes(w) ? 3 : 0) + (text.includes(w) ? 1 : 0);
    return s / words.length;
  }

  // ---------------------------------------------------------------- compact views for the model
  function courseCard(c, E, w) {
    return {
      id: c.id, name: c.n, ects: c.e, year: c.y, languages: c.l,
      scores: {maths: c.m, hands_on: c.h, ai_software: c.a, match: w ? E.courseMatch(c, w) : undefined},
      final_exam_pct: c.ex, hours_per_week: Math.round(c.hrs * 10) / 10,
      degrees: c.dg, skills_course: c.skills || undefined, recommended_by_past_students: c.rec || undefined,
      summary: c.ins ? c.ins.summary : (c.obj || "").slice(0, 180),
    };
  }
  function courseDetail(c, E, opts) {
    return {
      ...courseCard(c, E, opts.w), spanish_name: c.es, department: c.dept, assumed_knowledge: c.req,
      objectives: c.obj, contents: c.cont, assessment: (c.as || "").slice(0, 600), milestone_weeks: c.wk,
      insights: c.ins || null,
      groups: c.groups.map((g) => ({
        group: g.g, languages: g.l, allowed_by_current_constraints: E.groupAllowed(g, opts), hours_per_week: Math.round(g.hrs * 10) / 10,
        sessions: g.s.map((s, i) => `${E.DAYS[s[0]]} ${fmt(s[1])}-${fmt(s[2])} ${s[3] === "P" ? `lab x${g.weeks[i].length}wk` : "lecture"}`),
      })),
    };
  }
  const fmt = (m) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
  function planSummary(p, i, E) {
    return {
      plan: "ABC"[i], score: Math.round(p.score), ects: p.e, courses_count: p.mt.n,
      class_hours_per_week: Math.round(p.mt.hrs * 10) / 10, weekdays_without_class: p.mt.off.map((d) => E.DAYS[d]),
      avg_free_weekdays: Math.round(p.mt.offAvg * 10) / 10, idle_hours_per_week: Math.round(p.mt.gapHrs * 10) / 10,
      final_exam_share_pct: p.mt.exam == null ? null : Math.round(p.mt.exam), avg_maths: Math.round(p.mt.maths * 10) / 10,
      avg_ai: Math.round(p.mt.ai * 10) / 10,
      courses: p.picked.map((x, k) => ({
        id: x.c.id, name: x.c.n, ects: x.c.e, status: x.s === "auto" ? "suggested" : x.s, group: x.g.g, code: x.g.code.join("/"),
        days: [...x.g.days].sort().map((d) => E.DAYS[d]),
        best_fallback: p.robust && p.robust.perCourse[k].fb.alts[0] ? p.robust.perCourse[k].fb.alts[0].c.n : null,
      })),
    };
  }

  // ---------------------------------------------------------------- tool definitions (OpenAI function format)
  const DEFINITIONS = [
    {type: "function", function: {name: "get_state", description: "Current shortlist, weights, constraints and the plans currently shown.", parameters: {type: "object", properties: {}}}},
    {type: "function", function: {name: "search_courses", description: "Search the semester catalog. Returns compact course cards ranked by relevance to the query, then by match with the current weights.",
      parameters: {type: "object", properties: {
        query: {type: "string", description: "Free text: topic, course name, tool, career goal (English or Spanish)."},
        max_maths: {type: "number", description: "Upper bound on the maths score (1-5)."},
        min_ai: {type: "number", description: "Lower bound on the AI & software score (1-5)."},
        min_hands_on: {type: "number", description: "Lower bound on the hands-on score (1-5)."},
        max_final_exam_pct: {type: "number"},
        english_only: {type: "boolean", description: "Default true."},
        include_skills_courses: {type: "boolean", description: "Default false."},
        limit: {type: "integer", description: "1-25, default 10."},
      }}}},
    {type: "function", function: {name: "get_course", description: "Full details of one course: syllabus excerpts, AI insights, groups and their sessions.",
      parameters: {type: "object", properties: {id: {type: "integer"}}, required: ["id"]}}},
    {type: "function", function: {name: "update_shortlist", description: "Add, re-mark or remove courses. must = always included, want = preferred, backup = acceptable filler or fallback.",
      parameters: {type: "object", properties: {changes: {type: "array", items: {type: "object", properties: {
        id: {type: "integer"}, status: {type: "string", enum: ["must", "want", "backup", "remove"]}}, required: ["id", "status"]}}}, required: ["changes"]}}},
    {type: "function", function: {name: "set_preferences", description: "Set criterion weights (0-5) and hard constraints. Only the fields given change.",
      parameters: {type: "object", properties: {
        weights: {type: "object", description: `Any of ${WEIGHT_KEYS.join(", ")}; each 0-5.`, properties: Object.fromEntries(WEIGHT_KEYS.map((k) => [k, {type: "integer"}]))},
        target_ects: {type: "integer"}, max_ects: {type: "integer"},
        earliest_start: {type: "string", description: "HH:MM"}, latest_end: {type: "string", description: "HH:MM"},
        free_days: {type: "array", items: {type: "string", enum: WEEKDAYS}, description: "Weekdays that must stay free of classes."},
      }}}},
    {type: "function", function: {name: "build_plans", description: "Run the exact optimiser with the current shortlist, weights and constraints. Returns the best three plans with metrics and fallbacks.",
      parameters: {type: "object", properties: {}}}},
  ];

  function createTools(api, E) {
    const handlers = {
      get_state() {
        const s = api.getState();
        return {
          shortlist: Object.entries(s.status).map(([id, st]) => ({id: Number(id), name: api.model.courses[id]?.n, ects: api.model.courses[id]?.e, status: st})),
          weights: s.w, target_ects: s.target, max_ects: s.maxE, earliest_start: s.early, latest_end: s.late,
          free_days: s.off.map((d) => WEEKDAYS[d]), language: s.lang || "any",
          plans: (api.getPlans ? api.getPlans() : []).map((p, i) => planSummary(p, i, E)),
        };
      },
      search_courses(args) {
        const s = api.getState();
        const limit = clampInt(args.limit ?? 10, 1, 25);
        const english = args.english_only !== false;
        const query = String(args.query || "").trim();
        const rows = api.model.courses.filter((c) =>
          (!english || c.l.includes("English")) && (args.include_skills_courses || !c.skills)
          && (args.max_maths == null || c.m <= args.max_maths) && (args.min_ai == null || c.a >= args.min_ai)
          && (args.min_hands_on == null || c.h >= args.min_hands_on)
          && (args.max_final_exam_pct == null || (c.ex != null && c.ex <= args.max_final_exam_pct)));
        const ranked = rows.map((c) => ({c, q: query ? queryScore(c, query) : 0, m: E.courseMatch(c, s.w)}))
          .filter((r) => !query || r.q > 0)
          .sort((a, b) => b.q - a.q || b.m - a.m);
        return {total_matches: ranked.length, courses: ranked.slice(0, limit).map((r) => courseCard(r.c, E, s.w))};
      },
      get_course(args) {
        const c = api.model.courses[args.id];
        if (!c) return {error: `No course with id ${args.id}. Use search_courses to find ids.`};
        return courseDetail(c, E, {...api.getState()});
      },
      update_shortlist(args) {
        const applied = [], rejected = [];
        for (const ch of args.changes || []) {
          const c = api.model.courses[ch.id];
          if (!c) { rejected.push({id: ch.id, reason: "unknown id"}); continue; }
          if (ch.status === "remove") api.setStatus(c.id, null);
          else if (STATUSES.includes(ch.status)) api.setStatus(c.id, ch.status);
          else { rejected.push({id: ch.id, reason: `bad status ${ch.status}`}); continue; }
          applied.push({id: c.id, name: c.n, status: ch.status});
        }
        return {applied, rejected};
      },
      set_preferences(args) {
        const out = {};
        if (args.weights && typeof args.weights === "object") {
          const w = {};
          for (const k of WEIGHT_KEYS) if (args.weights[k] != null) w[k] = clampInt(args.weights[k], 0, 5);
          api.setWeights(w); out.weights = w;
        }
        const c = {};
        if (args.target_ects != null) c.target = clampInt(args.target_ects, 6, 60);
        if (args.max_ects != null) c.maxE = clampInt(args.max_ects, 6, 66);
        if (/^\d{1,2}:\d{2}$/.test(args.earliest_start || "")) c.early = args.earliest_start.padStart(5, "0");
        if (/^\d{1,2}:\d{2}$/.test(args.latest_end || "")) c.late = args.latest_end.padStart(5, "0");
        if (Array.isArray(args.free_days)) c.off = args.free_days.map((d) => WEEKDAYS.indexOf(d)).filter((d) => d >= 0);
        if (Object.keys(c).length) { api.setConstraints(c); out.constraints = c; }
        return {updated: out, state: handlers.get_state()};
      },
      async build_plans() {
        const r = await api.build();
        if (!r.plans.length) return {plans: [], problems: r.problems, hint: "No plan reaches the target: add backup courses or relax constraints."};
        return {search: {exhaustive: r.stats.complete, partial_plans_explored: r.stats.nodes, ms: r.stats.ms}, problems: r.problems,
          plans: r.plans.map((p, i) => planSummary(p, i, E))};
      },
    };
    return {
      definitions: DEFINITIONS,
      async run(name, args) {
        const fn = handlers[name];
        if (!fn) return {error: `Unknown tool ${name}`};
        try { return await fn(args || {}); } catch (err) { return {error: String(err && err.message || err)}; }
      },
    };
  }

  // ---------------------------------------------------------------- no-key wizard
  const WINDOWS = {late: {early: "10:45", late: "21:00"}, day: {early: "09:00", late: "19:00"}, any: {early: "09:00", late: "21:00"}};
  const DAYOFF = {fri: [4], mon: [0], none: []};

  /** Weights and hard constraints implied by the wizard answers. */
  function settingsFor(answers) {
    const w = {ai: 2, hands: 3, maths: 3, exam: 2, days: 3, hours: 3, gaps: 3, load: 2, prefs: 4};
    const topics = (answers.topics || []).filter((k) => TOPICS[k]);
    if (topics.some((t) => ["ai", "software", "data"].includes(t))) w.ai = 5;
    w.maths = {avoid: 5, ok: 2, love: 0}[answers.maths] ?? 3;
    w.exam = {continuous: 4, any: 1, finals: 0}[answers.exams] ?? 2;
    if (answers.schedule === "compact") Object.assign(w, {days: 5, hours: 4, gaps: 4});
    if (answers.schedule === "any") Object.assign(w, {days: 1, hours: 1, gaps: 1});
    const window = WINDOWS[answers.window] || WINDOWS.any;
    return {weights: w, topics, lang: answers.english === false ? "" : "English", ...window, off: DAYOFF[answers.dayoff] || []};
  }

  /** Courses still compatible with the answers given so far (the wizard's live counter). */
  function stillInTheRunning(answers, model, E) {
    const s = settingsFor(answers);
    return model.courses.filter((c) => !c.skills && (!s.lang || c.l.includes(s.lang))
      && (answers.maths !== "avoid" || c.m <= 3.5)
      && (!s.topics.length || topicScore(c, s.topics) > 0)
      && c.groups.some((g) => E.groupAllowed(g, s))).length;
  }

  /**
   * answers = {topics, maths: avoid|ok|love, exams: continuous|any|finals, window: late|day|any,
   *            dayoff: fri|mon|none, schedule: compact|balanced|any, english: bool}
   * Returns settings plus a shortlist proposal (4 Want + 6 Backup) ranked by topic relevance and match,
   * skipping courses in `exclude` (for "swap picks") and courses with no group that fits the constraints.
   */
  function planForMe(answers, model, E, keep = {}, exclude = new Set()) {
    const s = settingsFor(answers);
    const w = s.weights;
    const pool = model.courses.filter((c) => !c.skills && (!s.lang || c.l.includes(s.lang)) && c.e >= 3 && !keep[c.id] && !exclude.has(c.id)
      && c.groups.some((g) => E.groupAllowed(g, s)));
    const ranked = pool.map((c) => {
      const rel = topicScore(c, s.topics);
      const mathsPenalty = answers.maths === "avoid" && c.m > 3.5 ? 0.4 : 0;
      return {c, s: (s.topics.length ? rel * 0.6 : 0) + E.courseMatch(c, w) / 100 * 0.4 - mathsPenalty};
    }).sort((a, b) => b.s - a.s);
    const picks = [], seen = new Set(Object.keys(keep).flatMap((id) => [model.courses[id]?.fam, norm(model.courses[id]?.n)]));
    for (const r of ranked) {
      if (seen.has(r.c.fam) || seen.has(norm(r.c.n))) continue;   // same course under another degree's title
      seen.add(r.c.fam); seen.add(norm(r.c.n));
      picks.push(r.c);
      if (picks.length >= 10) break;
    }
    return {...s, shortlist: picks.map((c, i) => ({id: c.id, status: i < 4 ? "want" : "backup"}))};
  }

  /** Short, human reasons a course was picked: the facts that make it stand out. */
  function explainPick(c, topics = []) {
    const out = [];
    const hit = topics.find((k) => topicScore(c, [k]) > 0);
    if (hit) out.push(TOPICS[hit].label.toLowerCase());
    if (c.ex === 0) out.push("no final exam");
    else if (c.ex != null && c.ex <= 40) out.push(`final exam only ${c.ex}%`);
    else if (c.ex != null && c.ex >= 70) out.push(`${c.ex}% rides on the final`);
    if (c.m <= 1.6) out.push("barely any maths");
    else if (c.m >= 4) out.push("maths-heavy");
    if (c.h >= 4.3) out.push("very hands-on");
    if (c.a >= 4.5) out.push("deep in AI & software");
    if (c.hrs <= 2.6) out.push(`only ${c.hrs.toFixed(1)} h a week`);
    if (c.rec) out.push("past exchange students liked it");
    return out.slice(0, 4);
  }

  const api = {TOPICS, DEFINITIONS, createTools, planForMe, settingsFor, stillInTheRunning, explainPick, topicScore, queryScore, WEEKDAYS};
  root.PlannerTools = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
