/* Planner UI. Scoring and search live in engine.js; assistant tools in tools.js; the chat in advisor.js.
   This file renders the page, owns the state and exposes a small API (window.Planner) to the advisor. */
(function () {
  "use strict";
  const E = window.PlannerEngine;
  const T = window.PlannerTools;
  const D = window.DATASET;
  const {DAYS, CRITERIA, PRESETS} = E;
  const STORE = "uc3m-planner";

  // ---------------------------------------------------------------- optimiser worker
  // Built from the inlined engine source so the page stays responsive; falls back to the main thread.
  let worker = null, jobId = 0;
  const pending = new Map();
  const engineSrc = document.getElementById("engine-src")?.textContent;
  if (engineSrc && typeof Worker !== "undefined") {
    try {
      const shim = "\nlet model;onmessage=(e)=>{const m=e.data;if(m.type==='init'){model=PlannerEngine.prepare(m.dataset);return;}" +
        "postMessage({id:m.id,result:PlannerEngine.solve(model,m.opts)});};";
      worker = new Worker(URL.createObjectURL(new Blob([engineSrc, shim], {type: "text/javascript"})));
      worker.postMessage({type: "init", dataset: D});   // before prepare() decorates D in this thread
      worker.onmessage = (e) => { const done = pending.get(e.data.id); pending.delete(e.data.id); if (done) done(e.data.result); };
      worker.onerror = () => { worker = null; for (const [id, done] of pending) { pending.delete(id); done(null); } };
    } catch (err) { worker = null; }
  }
  const model = E.prepare(D);
  const C = model.courses;
  const solveAsync = (opts) => new Promise((resolve) => {
    const id = ++jobId;
    const local = () => setTimeout(() => resolve({id, result: E.solve(model, opts)}), 30);
    if (!worker) return local();
    pending.set(id, (result) => (result ? resolve({id, result}) : local()));
    worker.postMessage({type: "solve", id, opts});
  });

  // ---------------------------------------------------------------- state
  const defaults = {status: {}, target: 30, maxE: 33, early: "09:00", late: "21:00", off: [], deg: "", lang: "English", years: [],
    sort: "match", w: {...PRESETS.balanced}, preset: "balanced", auto: true, seeded: false};
  let st = {...defaults};
  try { const saved = JSON.parse(localStorage.getItem(STORE) || "{}"); st = {...defaults, ...saved, w: {...PRESETS.balanced, ...(saved.w || {})}}; } catch (err) { /* private mode */ }
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(st)); } catch (err) { /* storage unavailable */ } };
  let plans = [], cur = 0, problems = [], stats = null, searching = false;

  const $ = (id) => document.getElementById(id);
  const fmt = (m) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (ch) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[ch]));
  const norm = (s) => String(s).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const SHORT = {"data-science": "Data Science", "sciences": "Sciences", "eletrical": "Electrical", "electronic": "Ind. Electronics",
    "physics-engineering": "Eng. Physics", "aeroespace": "Aerospace", "sound-image": "Sound & Image", "computer-science": "Computer Sci.",
    "artificial-intelligence": "AI", "mathematics-applied": "Applied Maths", "mathematics-computing": "Maths & Comp.", "mechanical": "Mechanical",
    "robotics": "Robotics", "telematics": "Internet Eng.", "biomedical": "Biomedical", "industrial-technologies": "Ind. Technologies",
    "telecommunication": "Telecom", "energy": "Energy", "mobile-space-communications": "Mobile & Space"};
  const degShort = (d) => esc(SHORT[d] || d);
  const solveOpts = () => ({status: st.status, target: st.target, maxE: st.maxE, early: st.early, late: st.late, off: st.off, w: st.w,
    auto: st.auto, lang: st.lang, timeBudgetMs: 8000});
  const metricOpts = () => ({...solveOpts(), wantTotal: stats ? stats.wantTotal : 0});
  const groupOK = (g) => E.groupAllowed(g, solveOpts());
  const recomputeMatch = () => C.forEach((c) => { c.match = E.courseMatch(c, st.w); });
  const RANK = {must: 0, want: 1, backup: 2, auto: 3};
  const summaryOf = (c) => (c.ins && c.ins.summary) || (c.obj || "").replace(/\s+/g, " ").slice(0, 170);

  // ---------------------------------------------------------------- catalog
  function filtered(ignoreFits) {
    const q = norm($("q").value.trim()), p = plans[cur];
    const out = C.filter((c) => {
      if (st.deg && !c.dg.includes(st.deg)) return false;
      if (st.lang && !c.l.includes(st.lang)) return false;
      if (st.years.length && !c.y.some((y) => st.years.includes(y))) return false;
      if ($("maxM").checked && c.m > 3) return false;
      if ($("noEx").checked && !(c.ex != null && c.ex <= 50)) return false;
      if ($("hideSkills").checked && c.skills && !st.status[c.id]) return false;
      if ($("mine").checked && !st.status[c.id]) return false;
      if (q && T.queryScore(c, q) <= 0 && !c.codes.some((x) => x.includes(q))) return false;
      if (!ignoreFits && $("fits").checked && p && !p.picked.some((x) => x.c.id === c.id)
        && !c.groups.some((g) => groupOK(g) && E.fitsWith(g, p.picked))) return false;
      return true;
    });
    const key = {match: (c) => -c.match, m: (c) => c.m, h: (c) => -c.h, a: (c) => -c.a, ex: (c) => c.ex ?? 101, hrs: (c) => c.hrs, n: () => 0}[st.sort];
    const qScore = q ? (c) => -T.queryScore(c, q) : () => 0;
    return out.sort((a, b) => qScore(a) - qScore(b) || key(a) - key(b) || a.n.localeCompare(b.n));
  }
  const bar = (cls, label, v) => `<span class="bar ${cls}" title="${label}: ${v} of 5">${label}<i><b style="width:${(v - 1) / 4 * 100}%"></b></i></span>`;
  const segButtons = (c) => {
    const s = st.status[c.id] || "";
    return `<div class="seg" data-id="${c.id}" role="group" aria-label="Shortlist ${esc(c.n)}">${["must", "want", "backup"].map((v) => `<button type="button" data-v="${v}" class="${s === v ? "on" : ""}" aria-pressed="${s === v}">${v[0].toUpperCase() + v.slice(1)}</button>`).join("")}</div>`;
  };
  const langTags = (langs) => langs.map((l) => `<span class="tag ${l === "English" ? "en" : ""}">${l === "English" ? "EN" : l === "Spanish" ? "ES" : esc(l)}</span>`).join("");
  const nameMarked = (c) => (st.status[c.id] ? `<span class="hl hl-${st.status[c.id]}">${esc(c.n)}</span>` : esc(c.n));
  function renderList() {
    const items = filtered(false);
    $("count").textContent = `${items.length} of ${C.length}`;
    $("list").innerHTML = items.slice(0, 300).map((c) => `<article class="course" tabindex="0" data-open="${c.id}"><div>
        <div class="nm">${nameMarked(c)} ${c.rec ? '<span class="star" title="Recommended by past exchange students">★</span>' : ""}${c.skills ? ' <span class="tag">skills</span>' : ""}</div>
        <p class="sum">${esc(summaryOf(c))}</p>
        <div class="meta"><span class="match" title="How well this course on its own fits your weights (0-100)">${c.match}</span>${bar("a", "AI", c.a)}${bar("h", "hands-on", c.h)}${bar("m", "maths", c.m)}</div>
        <div class="meta"><span class="ects">${c.e} ECTS</span><span>${c.hrs.toFixed(1)} h/wk</span><span>exam ${c.ex == null ? "?" : c.ex + "%"}</span><span>Year ${c.y.join(", ")}</span>${langTags(c.l)}<span>${c.dg.slice(0, 2).map(degShort).join(" · ")}${c.dg.length > 2 ? ` +${c.dg.length - 2}` : ""}</span></div></div>
        ${segButtons(c)}</article>`).join("") || `<div class="empty">Nothing matches. Try “Any language”, another year or a shorter search.</div>`;
  }
  function renderShort() {
    const ids = Object.entries(st.status).filter(([id]) => C[id]).sort((a, b) => RANK[a[1]] - RANK[b[1]] || C[a[0]].n.localeCompare(C[b[0]].n));
    const tot = (s) => ids.filter((x) => x[1] === s).reduce((a, x) => a + C[x[0]].e, 0);
    $("sCount").textContent = ids.length ? `${tot("must") + tot("want") + tot("backup")} ECTS shortlisted` : "";
    $("short").innerHTML = ids.length ? ids.map(([id, s]) => {
      const c = C[id];
      return `<div class="sitem"><span class="pill ${s}">${s}</span><span class="nm" data-open="${id}" title="${esc(c.n)}">${esc(c.n)}</span><span class="ects">${c.e}</span><button class="x" type="button" data-rm="${id}" aria-label="Remove ${esc(c.n)}">✕</button></div>`;
    }).join("") : `<div class="empty" style="padding:6px 0">Nothing shortlisted yet. Mark courses in the catalog, use <b>Plan it for me</b>, or ask the advisor. With an empty list the optimiser picks from the best matches.</div>`;
  }

  // ---------------------------------------------------------------- map
  function renderMap() {
    const W = 640, H = 400, L = 40, R = 12, Tp = 12, B = 36;
    const X = (v) => L + (v - 1) / 4 * (W - L - R), Y = (v) => Tp + (5 - v) / 4 * (H - Tp - B);
    const visible = new Set(filtered(true).map((c) => c.id));
    const jitter = (id, k) => (((id * 9301 + 49297 * k) % 233280) / 233280 - 0.5) * 11;
    const tone = (a) => `var(--seq${Math.min(4, Math.floor((a - 1) / 0.8001))})`;
    let s = "";
    for (let v = 1; v <= 5; v++) {
      s += `<line class="axis ${v === 1 || v === 5 ? "edge" : ""}" x1="${X(v)}" x2="${X(v)}" y1="${Tp}" y2="${H - B}"></line><line class="axis ${v === 1 || v === 5 ? "edge" : ""}" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"></line>`;
      s += `<text x="${X(v)}" y="${H - B + 14}" text-anchor="middle">${v}</text><text x="${L - 8}" y="${Y(v) + 4}" text-anchor="end">${v}</text>`;
    }
    s += `<text class="quad" x="${X(1.05)}" y="${Y(4.9)}">Practical · light maths</text><text class="quad" x="${X(4.95)}" y="${Y(1.15)}" text-anchor="end">Theoretical · maths-heavy</text>`;
    s += `<text x="${(L + W - R) / 2}" y="${H - 4}" text-anchor="middle">Maths load →</text><text transform="translate(12 ${(Tp + H - B) / 2}) rotate(-90)" text-anchor="middle">Hands-on →</text>`;
    const order = C.filter((c) => !c.skills).sort((a, b) => (!!st.status[a.id]) - (!!st.status[b.id]) || a.rec - b.rec);
    for (const c of order) {
      const x = X(c.m) + jitter(c.id, 1), y = Y(c.h) + jitter(c.id, 2), r = c.e >= 6 ? 6 : 4.5, on = visible.has(c.id);
      s += `<circle class="dot ${st.status[c.id] || ""} ${on ? "" : "dim"}" data-open="${c.id}" tabindex="${on ? 0 : -1}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${tone(c.a)}"><title>${esc(c.n)} · maths ${c.m} · hands-on ${c.h} · AI ${c.a} · ${c.e} ECTS</title></circle>`;
      if (c.rec && on) s += `<circle class="rec" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r + 4}"></circle><text class="reclbl" x="${(x + r + 7).toFixed(1)}" y="${(y + 4).toFixed(1)}">${esc(c.n.length > 26 ? c.n.slice(0, 24) + "…" : c.n)}</text>`;
    }
    $("map").innerHTML = s;
  }

  // ---------------------------------------------------------------- course drawer
  function openCourse(id) {
    const c = C[id];
    if (!c) return;
    const ex = c.ex ?? null, co = c.co ?? (ex != null ? 100 - ex : null);
    const ins = c.ins;
    const list = (xs) => `<ul>${xs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
    const groups = c.groups.map((g) => `<div><div class="row between"><b class="mono">Group ${esc(g.g)}</b><span class="row">${langTags(g.l)}<span class="mono muted">${g.hrs.toFixed(1)} h/wk</span></span></div>
      <div class="fb">${g.s.map((s, i) => `${DAYS[s[0]]} ${fmt(s[1])}–${fmt(s[2])} ${s[3] === "P" ? `lab ×${g.weeks[i].length}` : "lecture"}`).join(" · ")}</div>
      <div class="fb">${g.deg.map(degShort).join(", ")} · code ${g.code.join("/")}${groupOK(g) ? "" : ' · <span class="warn">excluded by your language, hours or free days</span>'}</div></div>`).join("");
    $("drawer").innerHTML = `<button class="btn ghost close" id="dclose" type="button" aria-label="Close details">✕</button>
      <header><h2>${esc(c.n)}</h2><div class="meta" style="margin-top:6px"><span>${esc(c.es)}</span>${c.rec ? '<span class="star">★ recommended by past exchange students</span>' : ""}</div></header>
      <div class="row between">${segButtons(c)}${c.syl ? `<a href="${esc(c.syl)}" target="_blank" rel="noopener">Official syllabus ↗</a>` : ""}</div>
      <div class="meta"><span class="ects">${c.e} ECTS</span><span>Year ${c.y.join(", ")}</span>${langTags(c.l)}<span>${esc(c.dept)}</span></div>
      <div class="meta"><span class="match">match ${c.match}</span>${bar("a", "AI", c.a)}${bar("h", "hands-on", c.h)}${bar("m", "maths", c.m)}<span>labs ${Math.round(c.lab * 100)}% of class time</span></div>
      ${ins ? `<section class="insight"><div class="kicker">AI summary of the syllabus</div><p>${esc(ins.summary)}</p>
        ${ins.learn && ins.learn.length ? `<div><h4>You'll learn</h4>${list(ins.learn)}</div>` : ""}
        ${ins.useful && ins.useful.length ? `<div><h4>Useful for</h4>${list(ins.useful)}</div>` : ""}
        ${ins.tools && ins.tools.length ? `<div class="row">${ins.tools.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : ""}
        ${ins.watch ? `<p class="fb"><b>Heads-up:</b> ${esc(ins.watch)}</p>` : ""}</section>` : ""}
      <section><h4>Assessment</h4>${ex != null ? `<div class="split"><span class="ex" style="width:${ex}%">${ex ? "exam " + ex + "%" : ""}</span><span class="co" style="width:${co}%">${co ? "continuous " + co + "%" : ""}</span></div>` : "<p class=\"muted\">The syllabus doesn't give the split.</p>"}
        ${c.wk.length ? `<p class="fb" style="margin-top:6px">Deadlines in teaching weeks <b>${c.wk.join(", ")}</b></p>` : ""}</section>
      ${c.req ? `<section><h4>Assumed knowledge</h4><pre>${esc(c.req)}</pre></section>` : ""}
      ${c.obj ? `<section><h4>Objectives</h4><pre>${esc(c.obj)}</pre></section>` : ""}
      ${c.cont ? `<section><h4>Contents</h4><pre>${esc(c.cont)}</pre></section>` : ""}
      ${c.as ? `<details><summary class="lbl" style="cursor:pointer">How it's graded</summary><pre style="margin-top:6px">${esc(c.as)}</pre></details>` : ""}
      <section><h4>Groups (${c.groups.length})</h4><div class="gl">${groups}</div></section>`;
    $("drawer").hidden = false;
    $("dclose").focus();
  }

  // ---------------------------------------------------------------- plans
  const colorOf = (i) => `var(--c${i % 10})`;
  function renderStatus() {
    if (searching) { $("status").innerHTML = `<span class="spin" aria-hidden="true"></span> Searching every clash-free combination…`; return; }
    if (!stats) { $("status").textContent = ""; return; }
    $("status").innerHTML = `${stats.nodes.toLocaleString("en")} partial plans in ${(stats.ms / 1000).toFixed(1)} s · ${stats.candidates} candidate courses · ` +
      (stats.complete ? "<b>exhaustive</b>: these are the best plans for your settings" : "time limit reached: best plans found so far");
  }
  function renderMeter() {
    const p = plans[0];
    $("ectsText").textContent = `${p ? p.e : "–"} / ${st.target} ECTS`;
    $("ectsBar").style.width = `${p ? Math.min(100, p.e / st.target * 100) : 0}%`;
  }
  function renderPlan() {
    renderStatus(); renderMeter();
    $("tabs").innerHTML = plans.map((p, i) => `<button type="button" role="tab" aria-selected="${i === cur}" class="${i === cur ? "on" : ""}" data-tab="${i}">Plan ${"ABC"[i]} · ${Math.round(p.score)}</button>`).join("");
    const p = plans[cur];
    let h = problems.length ? `<p class="warn">${problems.map(esc).join("<br>")}</p>` : "";
    if (!p) {
      $("plan").innerHTML = h + (searching ? "" : `<div class="empty" style="padding:0">No plan reaches ${st.target} ECTS with these settings. Add Backup courses, widen the hours, free fewer days or let the optimiser add courses.</div>`);
      return;
    }
    const mt = p.mt, rb = p.robust;
    const raw = {days: `${mt.offAvg.toFixed(1)} free days/wk`, hours: `${mt.hrs.toFixed(1)} h/wk`, gaps: `${mt.gapHrs.toFixed(1)} h idle/wk`,
      exam: mt.exam == null ? "?" : `${Math.round(mt.exam)}% final exam`, maths: `maths ${mt.maths.toFixed(1)}/5`, ai: `AI ${mt.ai.toFixed(1)}/5`,
      hands: `${Math.round(mt.vals.hands * 100)}%`, load: `${mt.n} courses`, prefs: `${mt.wants} of ${stats.wantTotal} Want`};
    h += `<div class="headline"><div class="scorebox"><b>${Math.round(p.score)}</b><span class="lbl">/ 100</span></div><div class="stats">
        <div class="stat"><b class="${p.e < st.target ? "warn" : ""}">${p.e}</b><small>ECTS · ${mt.n} courses</small></div>
        <div class="stat"><b>${mt.hrs.toFixed(1)}</b><small>class hours / week</small></div>
        <div class="stat"><b>${mt.off.length ? mt.off.map((d) => DAYS[d]).join(" ") : "–"}</b><small>weekday${mt.off.length === 1 ? "" : "s"} without class</small></div>
        ${rb ? `<div class="stat"><b class="${rb.covered === rb.total ? "okc" : ""}">${rb.covered}/${rb.total}</b><small>courses with a good fallback</small></div>` : ""}
      </div></div>`;
    h += `<div><h4>Why this score</h4><div class="why">${CRITERIA.map((c) => `<span class="${st.w[c.k] ? "" : "w0"}" title="${esc(c.desc)}">${c.label} ×${st.w[c.k]}</span><span class="track" title="${Math.round(mt.vals[c.k] * 100)}% of the best possible"><b style="width:${Math.round(mt.vals[c.k] * 100)}%"></b></span><span class="val">${raw[c.k]}</span>`).join("")}</div>
      ${p.e > st.target ? `<p class="fb" style="margin-top:6px">−${((p.e - st.target) * E.EXCESS_PENALTY).toFixed(1)} points for ${p.e - st.target} ECTS above the target.</p>` : ""}</div>`;
    if (plans.length > 1) {
      const rows = [["Score", (q) => q.score, (v) => Math.round(v), 1], ["Courses", (q) => q.mt.n, (v) => v, -1],
        ["AI & software (1–5)", (q) => q.mt.ai, (v) => v.toFixed(1), 1], ["Maths (1–5)", (q) => q.mt.maths, (v) => v.toFixed(1), -1],
        ["Final-exam share", (q) => q.mt.exam ?? 50, (v) => Math.round(v) + "%", -1], ["Class hours / week", (q) => q.mt.hrs, (v) => v.toFixed(1), -1],
        ["Idle hours / week", (q) => q.mt.gapHrs, (v) => v.toFixed(1), -1], ["Free weekdays / week", (q) => q.mt.offAvg, (v) => v.toFixed(1), 1]];
      h += `<div class="scroll"><h4>Compare</h4><table class="cmp"><thead><tr><th></th>${plans.map((q, i) => `<th>Plan ${"ABC"[i]}</th>`).join("")}</tr></thead><tbody>${rows.map(([label, f, show, dir]) => {
        const vals = plans.map(f), top = dir > 0 ? Math.max(...vals) : Math.min(...vals);
        return `<tr><td>${label}</td>${vals.map((v) => `<td class="${v === top && new Set(vals).size > 1 ? "win" : ""}">${show(v)}</td>`).join("")}</tr>`;
      }).join("")}</tbody></table></div>`;
    }
    h += `<div class="scroll"><h4>Courses and fallbacks</h4><table class="ptable"><thead><tr><th>Course</th><th>ECTS</th><th>Group</th><th>If it's full (plan score after the swap)</th></tr></thead><tbody>`;
    p.picked.forEach((x, k) => {
      const fb = rb ? rb.perCourse[k].fb : {otherGroups: [], alts: []}, g = x.g;
      h += `<tr><td><span class="sw" style="background:${colorOf(k)}"></span><a href="#" data-open="${x.c.id}">${esc(x.c.n)}</a> <span class="pill ${x.s}">${x.s === "auto" ? "suggested" : x.s}</span><div class="fb">${esc(summaryOf(x.c).slice(0, 110))}${summaryOf(x.c).length > 110 ? "…" : ""}</div></td><td class="ects">${x.c.e}</td>
        <td><span class="mono">${esc(g.g)}</span> · ${[...g.days].sort().map((d) => DAYS[d]).join(" ")}<div class="fb">code ${g.code.join("/")}</div></td>
        <td class="fb">${fb.otherGroups.length ? `Other group: <b>${fb.otherGroups.slice(0, 3).map((o) => `${esc(o.g.g)} (${Math.round(o.score)})`).join(", ")}</b><br>` : ""}${fb.alts.length ? fb.alts.map((a) => `→ <a href="#" data-open="${a.c.id}">${esc(a.c.n)}</a> · ${a.reaches ? Math.round(a.score) : `under ${st.target} ECTS`}`).join("<br>") : "No clash-free replacement"}</td></tr>`;
    });
    h += `</tbody></table></div>`;
    $("plan").innerHTML = h + weekGrid(p) + semesterStrip(p);
  }

  function weekGrid(p) {
    const all = p.picked.flatMap((x, k) => x.g.s.map((s, i) => ({s, k, c: x.c, ghost: false, wks: x.g.weeks[i].length})));
    if ($("ghost").checked) p.picked.forEach((x, k) => x.c.groups.forEach((g) => {
      if (g !== x.g && groupOK(g)) g.s.forEach((s, i) => all.push({s, k, c: x.c, ghost: true, g: g.g, wks: g.weeks[i].length}));
    }));
    const lo = Math.min(E.toMin(st.early), ...all.map((a) => a.s[1])), hi = Math.max(...all.map((a) => a.s[2]), lo + 240);
    const top = Math.floor(lo / 60) * 60, bot = Math.ceil(hi / 60) * 60, px = 0.85;
    let cal = `<div><h4>Week</h4><div class="scroll"><div class="cal" style="grid-template-columns:46px repeat(5, minmax(112px,1fr))"><div></div>${DAYS.slice(0, 5).map((d, i) => `<div class="dh ${p.mt.off.includes(i) ? "off" : ""}">${d}${p.mt.off.includes(i) ? " · free" : ""}</div>`).join("")}`;
    cal += `<div class="hours" style="height:${(bot - top) * px}px">${Array.from({length: (bot - top) / 60 + 1}, (_, i) => `<span style="top:${i * 60 * px}px">${fmt(top + i * 60)}</span>`).join("")}</div>`;
    for (let d = 0; d < 5; d++) {
      cal += `<div class="col ${p.mt.off.includes(d) ? "off" : ""}" style="height:${(bot - top) * px}px;background-image:repeating-linear-gradient(to bottom, var(--rule-2) 0 1px, transparent 1px ${60 * px}px)">`;
      all.filter((a) => a.s[0] === d).sort((a, b) => b.ghost - a.ghost).forEach((a) => {
        cal += `<div class="blk ${a.s[3]} ${a.ghost ? "ghost" : ""}" data-open="${a.c.id}" style="--cc:${colorOf(a.k)};top:${(a.s[1] - top) * px}px;height:${(a.s[2] - a.s[1]) * px - 2}px;${a.ghost ? "left:55%;" : ""}" title="${esc(a.c.n)}${a.ghost ? " · other group " + esc(a.g) : ""} · ${a.s[3] === "P" ? "lab" : "lecture"} · ${fmt(a.s[1])}–${fmt(a.s[2])} · ${a.wks} weeks · ${esc(a.s[5])}">
          <div class="t">${fmt(a.s[1])}${a.s[3] === "P" ? ` · lab ${a.wks}w` : ""}${a.ghost ? " · grp " + esc(a.g) : ""}</div>${esc(a.c.n)}</div>`;
      });
      cal += `</div>`;
    }
    return cal + `</div></div><div class="legend" style="margin-top:8px"><span>Solid: weekly lecture</span><span>Hatched: lab, some weeks only</span>${$("ghost").checked ? "<span>Dashed: other groups</span>" : ""}<span>Green column: no class that day</span></div></div>`;
  }

  function semesterStrip(p) {
    const cal = D.calendar, weeks = Array.from({length: cal.calendar_weeks}, (_, i) => i + 1);
    const label = (w) => new Date(Date.UTC(2027, 0, 1 + cal.first_monday + (w - 1) * 7)).toLocaleDateString("en-GB", {day: "numeric", month: "short", timeZone: "UTC"});
    const teachToCal = (w) => (w >= cal.break_week ? w + 1 : w);
    let h = `<div><h4>Semester: hours, deadlines and exams</h4><div class="scroll"><table class="strip"><thead><tr><th class="nm">Course</th>${weeks.map((w) => w === cal.break_week ? `<th class="brk">Break</th>` : `<th title="week of ${label(w)}">${label(w)}</th>`).join("")}<th>Exams<br>${esc(cal.exams)}</th></tr></thead><tbody>`;
    const totals = weeks.map(() => 0);
    p.picked.forEach((x, k) => {
      const per = weeks.map(() => ({min: 0, lab: false}));
      x.g.s.forEach((s, i) => x.g.weeks[i].forEach((w) => { per[w - 1].min += s[2] - s[1]; if (s[3] === "P") per[w - 1].lab = true; }));
      const milestones = new Set(x.c.wk.map(teachToCal));
      h += `<tr><td class="nm" title="${esc(x.c.n)}"><span class="sw" style="background:${colorOf(k)}"></span>${esc(x.c.n)}</td>`;
      weeks.forEach((w, i) => {
        totals[i] += per[i].min;
        if (w === cal.break_week) { h += `<td class="brk"></td>`; return; }
        const a = Math.min(1, per[i].min / 300);
        h += `<td title="${(per[i].min / 60).toFixed(1)} h${per[i].lab ? " incl. lab" : ""}${milestones.has(w) ? " · deadline" : ""}"><span class="cell" style="background:color-mix(in srgb, ${colorOf(k)} ${Math.round(a * 65)}%, transparent)">${milestones.has(w) ? '<span class="ms">◆</span>' : per[i].lab ? '<span class="ms" style="font-size:9px">L</span>' : ""}</span></td>`;
      });
      h += `<td class="exam">${x.c.ex == null ? "?" : x.c.ex === 0 ? "none" : x.c.ex + "%"}</td></tr>`;
    });
    h += `<tr><td class="nm"><b>Hours</b></td>${weeks.map((w, i) => w === cal.break_week ? `<td class="brk"></td>` : `<td class="ects">${(totals[i] / 60).toFixed(0)}</td>`).join("")}<td></td></tr>`;
    return h + `</tbody></table></div><div class="legend" style="margin-top:8px"><span>Darker: more class hours</span><span>L: lab week</span><span>◆: deadline named in the syllabus</span><span>Exams: share of the grade</span></div></div>`;
  }
  function renderAll() { renderList(); renderShort(); renderMap(); renderPlan(); }

  // ---------------------------------------------------------------- build
  async function build() {
    recomputeMatch();
    searching = true; renderPlan();
    const {id, result} = await solveAsync(solveOpts());
    if (id !== jobId) return {plans, stats, problems, superseded: true};   // a newer search replaced this one
    searching = false; stats = result.stats; problems = result.problems; cur = 0;
    const mopts = metricOpts();
    plans = result.plans.map((pl) => {
      const picked = E.hydrate(model, pl).sort((a, b) => RANK[a.s] - RANK[b.s] || a.c.n.localeCompare(b.c.n));
      return {picked, e: picked.reduce((a, x) => a + x.c.e, 0), score: pl.score, mt: E.metrics(model, picked, mopts), robust: E.robustness(model, picked, mopts, pl.score)};
    });
    renderAll();
    return {plans, stats, problems};
  }
  const debounce = (fn, ms) => { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; };
  const rebuildSoon = debounce(build, 500);

  // ---------------------------------------------------------------- public API (advisor, wizard)
  const Planner = {
    model, dataset: D, openCourse,
    getState: () => st,
    getPlans: () => plans,
    setStatus(id, s) { if (s) st.status[id] = s; else delete st.status[id]; save(); renderList(); renderShort(); renderMap(); },
    setWeights(w) { Object.assign(st.w, w); st.preset = ""; save(); recomputeMatch(); renderSliders(); renderList(); },
    setConstraints(c) { Object.assign(st, c); save(); syncInputs(); },
    setLanguage(lang) { st.lang = lang; save(); syncInputs(); renderList(); renderMap(); },
    build,
    scrollToPlans: () => $("plans").scrollIntoView({behavior: "smooth"}),
  };
  window.Planner = Planner;

  // ---------------------------------------------------------------- wizard (no key needed)
  const WZ = [
    {key: "topics", title: "What do you want to get out of this semester?", hint: "Pick up to three.", multi: 3,
      options: Object.entries(T.TOPICS).map(([k, t]) => ({v: k, label: t.label}))},
    {key: "maths", title: "How do you feel about maths-heavy courses?", options: [
      {v: "avoid", label: "Keep it light", sub: "Prefer applied, practical courses"}, {v: "ok", label: "Some is fine", sub: "If the course is worth it"},
      {v: "love", label: "Bring it on", sub: "Theory doesn't scare me"}]},
    {key: "exams", title: "How do you prefer to be graded?", options: [
      {v: "continuous", label: "Continuous work", sub: "Projects, labs, assignments"}, {v: "any", label: "No preference", sub: ""},
      {v: "finals", label: "Final exams", sub: "One big push at the end"}]},
    {key: "schedule", title: "What should your week look like?", options: [
      {v: "compact", label: "Compact", sub: "Fewer days on campus, few gaps"}, {v: "balanced", label: "Balanced", sub: "Some structure, no extremes"},
      {v: "any", label: "Doesn't matter", sub: "Content first"}]},
    {key: "english", title: "Which teaching language works for you?", options: [
      {v: true, label: "English only", sub: ""}, {v: false, label: "English or Spanish", sub: "I'm comfortable in Spanish"}]},
  ];
  let wzStep = 0, wzAnswers = {topics: []};
  function renderWizard() {
    const q = WZ[wzStep], dlg = $("wizard");
    const chosen = (v) => (q.multi ? wzAnswers.topics.includes(v) : wzAnswers[q.key] === v);
    dlg.innerHTML = `<form class="wz" method="dialog">
      <div class="progress">${WZ.map((_, i) => `<span class="${i <= wzStep ? "on" : ""}"></span>`).join("")}</div>
      <div><p class="eyebrow">Step ${wzStep + 1} of ${WZ.length} · no account or key needed</p><h2>${esc(q.title)}</h2>${q.hint ? `<p class="muted" style="margin:6px 0 0">${q.hint}</p>` : ""}</div>
      <div class="grid">${q.options.map((o, i) => `<button type="button" class="choice" data-i="${i}" aria-pressed="${chosen(o.v)}"><b>${esc(o.label)}</b>${o.sub ? `<small>${esc(o.sub)}</small>` : ""}</button>`).join("")}</div>
      <div class="foot"><button type="button" class="btn ghost" data-wz="${wzStep ? "back" : "close"}">${wzStep ? "Back" : "Cancel"}</button>
        <button type="button" class="btn primary" data-wz="next">${wzStep === WZ.length - 1 ? "Build my plan" : "Next"}</button></div></form>`;
  }
  function openWizard() { wzStep = 0; wzAnswers = {topics: [], maths: "ok", exams: "any", schedule: "balanced", english: st.lang !== ""}; renderWizard(); $("wizard").showModal(); }
  $("wizard").addEventListener("click", (e) => {
    const choice = e.target.closest(".choice"), nav = e.target.closest("[data-wz]");
    const q = WZ[wzStep];
    if (choice) {
      const v = q.options[+choice.dataset.i].v;
      if (q.multi) {
        const t = wzAnswers.topics;
        wzAnswers.topics = t.includes(v) ? t.filter((x) => x !== v) : t.length < q.multi ? [...t, v] : t;
      } else wzAnswers[q.key] = v;
      renderWizard();
    } else if (nav) {
      const a = nav.dataset.wz;
      if (a === "close") $("wizard").close();
      else if (a === "back") { wzStep--; renderWizard(); }
      else if (wzStep < WZ.length - 1) { wzStep++; renderWizard(); }
      else { $("wizard").close(); applyWizard(); }
    }
  });
  async function applyWizard() {
    const keep = Object.fromEntries(Object.entries(st.status).filter(([, s]) => s === "must"));
    const out = T.planForMe(wzAnswers, model, E, keep);
    st.status = {...keep};
    out.shortlist.forEach((x) => { st.status[x.id] = x.status; });
    st.w = {...out.weights}; st.preset = ""; st.lang = out.lang; st.auto = true;
    if (wzAnswers.schedule === "compact" && !st.off.length) st.off = [];
    save(); syncInputs(); renderSliders(); recomputeMatch(); renderAll();
    Planner.scrollToPlans();
    await build();
    toast(`Shortlisted ${out.shortlist.length} courses and built your plans`);
  }

  // ---------------------------------------------------------------- controls
  function renderSliders() {
    $("sliders").innerHTML = CRITERIA.map((c) => `<label class="sl"><span class="top">${c.label}<output>${st.w[c.k]}</output></span><input type="range" min="0" max="5" step="1" data-w="${c.k}" id="w-${c.k}" value="${st.w[c.k]}" aria-label="${c.label} weight"><small>${c.desc}</small></label>`).join("");
    document.querySelectorAll("#presets button").forEach((b) => b.classList.toggle("on", b.dataset.preset === st.preset));
  }
  function syncInputs() {
    ["deg", "lang", "sort", "target", "maxE", "early", "late"].forEach((id) => { $(id).value = st[id]; });
    $("auto").checked = st.auto;
    document.querySelectorAll("#daysOff input").forEach((i) => { i.checked = st.off.includes(+i.dataset.off); });
    renderMeter();
  }
  function setStatusFromUI(id, v) {
    Planner.setStatus(id, st.status[id] === v ? null : v);
    if (!$("drawer").hidden) openCourse(id);
    rebuildSoon();
  }
  function copyPlan() {
    const p = plans[cur];
    if (!p) return;
    const lines = [`UC3M ${D.campus}, semester ${D.semester} ${D.year}: plan ${"ABC"[cur]} (score ${Math.round(p.score)}/100), ${p.e} ECTS, ${p.mt.n} courses, ${p.mt.hrs.toFixed(1)} class h/week`];
    p.picked.forEach((x, k) => {
      lines.push(`- ${x.c.n} | ${x.c.e} ECTS | code ${x.g.code.join("/")} | group ${x.g.g} | ${x.g.deg.map((d) => D.degrees[d]).join(", ")} | final exam ${x.c.ex ?? "?"}%`);
      x.g.s.forEach((s, i) => lines.push(`    ${DAYS[s[0]]} ${fmt(s[1])}-${fmt(s[2])} ${s[3] === "P" ? `lab (${x.g.weeks[i].length} weeks)` : "lecture"} ${s[5]}`));
      const fb = p.robust && p.robust.perCourse[k].fb;
      if (fb && fb.alts.length) lines.push(`    fallback: ${fb.alts.map((a) => `${a.c.n} (${a.c.e} ECTS, code ${a.g.code.join("/")}, group ${a.g.g})`).join("; ")}`);
    });
    const text = lines.join("\n");
    const fallback = () => {
      const ta = document.createElement("textarea");
      ta.value = text; ta.rows = 10; ta.style.width = "100%";
      $("plan").prepend(ta); ta.select(); toast("Select the text above the plan and copy it");
    };
    try { navigator.clipboard.writeText(text).then(() => toast("Plan copied"), fallback); } catch (err) { fallback(); }
  }
  function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 2400); }
  Planner.toast = toast;

  function init() {
    const cal = D.calendar;
    const english = C.filter((c) => c.l.includes("English")).length;
    $("eyebrow").textContent = `Exchange semester · School of Engineering · ${D.campus} · semester ${D.semester}, ${D.year}`;
    $("intro").textContent = `Every course from the 19 bachelors open to exchange students, scored from its syllabus. Shortlist what interests you, say what matters, and an exact optimiser builds the best clash-free ${st.target}-ECTS timetables, with a fallback for every course.`;
    $("keydates").innerHTML = [["Classes", cal.classes], ["Break", cal.break], ["Final exams", cal.exams], ["Resits", cal.resits]].map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("");
    $("facts").innerHTML = `<span><b>${C.length}</b> courses</span><span><b>${english}</b> with an English group</span><span><b>${C.reduce((a, c) => a + c.groups.length, 0)}</b> teaching groups</span><span><b>19</b> degrees</span>`;
    $("source").textContent = `Data from uc3m.es study plans, syllabi and the official timetable site, fetched ${D.scraped}. Check the official pages before you enrol.`;
    Object.entries(D.degrees).forEach(([k, v]) => $("deg").insertAdjacentHTML("beforeend", `<option value="${k}">${esc(v)}</option>`));
    $("years").innerHTML = `<span class="lbl">Year</span>` + [1, 2, 3, 4].map((y) => `<label class="chip"><input type="checkbox" data-y="${y}" ${st.years.includes(y) ? "checked" : ""}> ${y}</label>`).join("");
    $("daysOff").innerHTML = DAYS.slice(0, 5).map((d, i) => `<label class="chip"><input type="checkbox" data-off="${i}"> ${d}</label>`).join("");
    if (!st.seeded) {   // first visit: start from the courses past exchange students recommended
      C.filter((c) => c.rec && c.e >= 6 && c.l.includes("English")).forEach((c) => { st.status[c.id] = "want"; });
      st.seeded = true; save();
    }
    syncInputs(); recomputeMatch(); renderSliders();

    ["q", "mine", "fits", "maxM", "noEx", "hideSkills"].forEach((id) => $(id).addEventListener("input", () => { renderList(); renderMap(); }));
    ["deg", "lang", "sort"].forEach((id) => $(id).addEventListener("change", () => { st[id] = $(id).value; save(); renderList(); renderMap(); if (id === "lang") rebuildSoon(); }));
    $("years").addEventListener("change", (e) => { const y = +e.target.dataset.y; st.years = e.target.checked ? [...st.years, y] : st.years.filter((v) => v !== y); save(); renderList(); renderMap(); });
    $("daysOff").addEventListener("change", (e) => { const d = +e.target.dataset.off; st.off = e.target.checked ? [...st.off, d] : st.off.filter((v) => v !== d); save(); rebuildSoon(); });
    ["target", "maxE"].forEach((id) => $(id).addEventListener("change", () => { st[id] = Math.max(1, +$(id).value || defaults[id]); save(); renderMeter(); rebuildSoon(); }));
    ["early", "late"].forEach((id) => $(id).addEventListener("change", () => { st[id] = $(id).value || st[id]; save(); rebuildSoon(); }));
    $("auto").addEventListener("change", () => { st.auto = $("auto").checked; save(); rebuildSoon(); });
    $("ghost").addEventListener("change", renderPlan);
    $("sliders").addEventListener("input", (e) => {
      const k = e.target.dataset.w;
      if (!k) return;
      st.w[k] = +e.target.value; st.preset = "";
      e.target.closest(".sl").querySelector("output").textContent = e.target.value;
      document.querySelectorAll("#presets button").forEach((b) => b.classList.remove("on"));
      save(); recomputeMatch(); renderList(); rebuildSoon();
    });
    $("presets").addEventListener("click", (e) => { const p = e.target.dataset.preset; if (!p) return; st.w = {...PRESETS[p]}; st.preset = p; save(); renderSliders(); build(); });
    $("clear").addEventListener("click", () => { st.status = {}; save(); renderAll(); rebuildSoon(); });
    ["openWizard", "heroWizard"].forEach((id) => $(id).addEventListener("click", openWizard));
    document.addEventListener("click", (e) => {
      const b = e.target.closest(".seg button");
      if (b) { e.stopPropagation(); setStatusFromUI(b.parentElement.dataset.id, b.dataset.v); return; }
      const rm = e.target.closest("[data-rm]");
      if (rm) { Planner.setStatus(rm.dataset.rm, null); rebuildSoon(); return; }
      const t = e.target.closest("[data-tab]");
      if (t) { cur = +t.dataset.tab; renderPlan(); if ($("fits").checked) renderList(); return; }
      if (e.target.closest("#dclose")) { $("drawer").hidden = true; return; }
      const o = e.target.closest("[data-open]");
      if (o) { e.preventDefault(); openCourse(o.dataset.open); }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !$("drawer").hidden) $("drawer").hidden = true;
      if ((e.key === "Enter" || e.key === " ") && e.target.matches && e.target.matches(".course, circle")) { e.preventDefault(); openCourse(e.target.dataset.open); }
    });
    $("go").addEventListener("click", build);
    $("copy").addEventListener("click", copyPlan);
    renderAll();
    build();
  }
  init();
})();
