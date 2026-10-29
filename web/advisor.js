/*
 * AI advisor: a chat that drives the planner through tools (tools.js) using any tool-capable model on
 * OpenRouter. Bring-your-own-key: the key is kept in this browser's localStorage and sent only to
 * openrouter.ai. The LLM decides what to aim for; the exact optimiser decides what is feasible.
 */
(function () {
  "use strict";
  const P = window.Planner, E = window.PlannerEngine, T = window.PlannerTools;
  if (!P) return;
  const API = "https://openrouter.ai/api/v1";
  const KEY = "uc3m-advisor-key", MODEL = "uc3m-advisor-model", HIST = "uc3m-advisor-history";
  const PREFERRED = ["anthropic/claude-sonnet", "anthropic/claude", "openai/gpt-5", "openai/gpt-4.1", "google/gemini-2.5-pro", "google/gemini"];
  const MAX_STEPS = 10;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (ch) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[ch]));
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* unavailable */ } },
  };

  const tools = T.createTools({
    model: P.model, getState: P.getState, getPlans: P.getPlans, setStatus: P.setStatus, setWeights: P.setWeights,
    setConstraints: P.setConstraints, build: async () => { const r = await P.build(); P.scrollToPlans(); return r; },
  }, E);

  const D = P.dataset, cal = D.calendar;
  const SYSTEM = `You are the course advisor inside "UC3M Course Planner", a tool for exchange students choosing courses at Universidad Carlos III de Madrid, School of Engineering (EPS), ${D.campus} campus, semester ${D.semester} of ${D.year}.
Calendar: classes ${cal.classes}, break ${cal.break}, final exams ${cal.exams}, resits ${cal.resits}.
The catalog has ${P.model.courses.length} courses from 19 bachelors. Scores (1-5, relative to the catalog) are heuristic estimates from syllabus text: maths load, hands-on share, AI & software focus. "insights" are AI-written summaries of the official syllabus.

How to work:
- First understand the student: interests, career goals, comfort with maths, preferred assessment, timetable wishes, teaching language. Ask at most two short questions at a time; if they say "just do it", assume sensible defaults and say which.
- Never invent courses, codes, times or facts. Use search_courses and get_course for anything specific.
- Shortlist with update_shortlist (want = preferred, backup = acceptable, must = only if the student insists), set weights and constraints with set_preferences, then ALWAYS call build_plans before recommending a plan. The optimiser is exact; trust its feasibility and explain its trade-offs.
- Aim for a shortlist of 40-60 ECTS so the optimiser has room and fallbacks exist.
- When explaining a course, say what the student will learn and how it is useful (skills, tools, careers), and flag heavy maths or big final exams.
- Reference courses as markdown links of the form [Course name](#c<ID>) so the student can click them.
- Be concise and concrete (under 180 words unless asked for more). Use short lists.
- Remind the student, once, to confirm choices with their home coordinator and the official UC3M pages.`;

  let history = [];
  try { history = JSON.parse(sessionStorage.getItem(HIST) || "[]"); } catch (e) { history = []; }
  const saveHistory = () => { try { sessionStorage.setItem(HIST, JSON.stringify(history.slice(-40))); } catch (e) { /* ignore */ } };
  let busy = false, models = null;

  // ---------------------------------------------------------------- markdown-lite rendering
  function inline(s) {
    return esc(s)
      .replace(/\[([^\]]+)\]\(#c(\d+)\)/g, '<a class="cref" data-open="$2" href="#">$1</a>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  }
  function markdown(text) {
    const out = [];
    let list = null;
    for (const raw of String(text || "").split("\n")) {
      const line = raw.trimEnd();
      const ul = line.match(/^\s*[-*•]\s+(.*)/), ol = line.match(/^\s*\d+[.)]\s+(.*)/);
      if (ul || ol) {
        const tag = ul ? "ul" : "ol";
        if (list !== tag) { if (list) out.push(`</${list}>`); out.push(`<${tag}>`); list = tag; }
        out.push(`<li>${inline((ul || ol)[1])}</li>`);
        continue;
      }
      if (list) { out.push(`</${list}>`); list = null; }
      if (!line.trim()) continue;
      const h = line.match(/^#{1,4}\s+(.*)/);
      out.push(h ? `<p><strong>${inline(h[1])}</strong></p>` : `<p>${inline(line)}</p>`);
    }
    if (list) out.push(`</${list}>`);
    return out.join("");
  }
  const STEP_LABEL = {
    get_state: () => "read your settings",
    search_courses: (a, r) => `searched “${a.query || "catalog"}” · ${r.total_matches ?? 0}`,
    get_course: (a, r) => `read ${r.name || "course #" + a.id}`,
    update_shortlist: (a, r) => `shortlist · ${(r.applied || []).length} change${(r.applied || []).length === 1 ? "" : "s"}`,
    set_preferences: () => "updated preferences",
    build_plans: (a, r) => (r.plans && r.plans.length ? `built plans · best ${r.plans[0].score}` : "built plans · none fit"),
  };

  // ---------------------------------------------------------------- OpenRouter
  async function call(messages) {
    const res = await fetch(`${API}/chat/completions`, {
      method: "POST",
      headers: {"Authorization": `Bearer ${store.get(KEY)}`, "Content-Type": "application/json",
        "HTTP-Referer": location.origin || "https://polluxgnr.github.io", "X-Title": "UC3M Course Planner"},
      body: JSON.stringify({model: store.get(MODEL), messages, tools: tools.definitions, tool_choice: "auto", temperature: 0.3}),
    });
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.json()).error?.message || ""; } catch (e) { /* not JSON */ }
      const hint = {401: "The key was rejected. Check it on openrouter.ai/keys.", 402: "The OpenRouter account is out of credits.", 429: "Rate limited. Wait a moment and try again."}[res.status];
      throw new Error(hint || `OpenRouter error ${res.status}${detail ? ": " + detail : ""}`);
    }
    const data = await res.json();
    if (!data.choices || !data.choices[0]) throw new Error(data.error?.message || "Empty response from the model.");
    return data.choices[0].message;
  }
  async function loadModels() {
    if (models) return models;
    const res = await fetch(`${API}/models`);
    const all = (await res.json()).data || [];
    const withTools = all.filter((m) => (m.supported_parameters || []).includes("tools"));
    const rank = (id) => { const i = PREFERRED.findIndex((p) => id.startsWith(p)); return i < 0 ? 99 : i; };
    models = withTools.sort((a, b) => rank(a.id) - rank(b.id) || (b.created || 0) - (a.created || 0));
    return models;
  }

  // The last ~30 API messages, cut at a user turn so no tool result is orphaned from its call.
  function conversation() {
    const msgs = history.filter((m) => !m.error).map(({role, content, tool_calls, tool_call_id, name}) =>
      ({role, content: content ?? "", ...(tool_calls ? {tool_calls} : {}), ...(tool_call_id ? {tool_call_id, name} : {})}));
    let start = Math.max(0, msgs.length - 30);
    while (start > 0 && msgs[start].role !== "user") start--;
    return msgs.slice(start);
  }

  async function send(text) {
    if (busy || !text.trim()) return;
    busy = true;
    history.push({role: "user", content: text.trim()});
    saveHistory(); renderMessages(true);
    const steps = [];
    try {
      for (let i = 0; i < MAX_STEPS; i++) {
        const msg = await call([{role: "system", content: SYSTEM}, ...conversation()]);
        const entry = {role: "assistant", content: msg.content || ""};
        if (msg.tool_calls && msg.tool_calls.length) entry.tool_calls = msg.tool_calls;
        history.push(entry);
        if (!entry.tool_calls) break;
        for (const tc of entry.tool_calls) {
          let args = {};
          try { args = JSON.parse(tc.function.arguments || "{}"); } catch (e) { args = {}; }
          const result = await tools.run(tc.function.name, args);
          history.push({role: "tool", tool_call_id: tc.id, name: tc.function.name, content: JSON.stringify(result)});
          const label = STEP_LABEL[tc.function.name];
          steps.push(label ? label(args, result) : tc.function.name);
          renderMessages(true, steps);
        }
      }
    } catch (err) {
      history.push({role: "assistant", content: "", error: err.message || String(err)});
    }
    busy = false;
    saveHistory(); renderMessages(false);
  }

  // ---------------------------------------------------------------- UI
  const SUGGESTIONS = [
    "Build me a 30 ECTS plan focused on AI and software, light on maths",
    "What will I actually learn in Mobile Applications, and is it useful?",
    "Compare Machine Learning and Artificial Intelligence for me",
    "Keep Fridays free and avoid big final exams",
  ];
  function renderMessages(thinking, steps) {
    const box = $("msgs");
    if (!box) return;
    const visible = history.filter((m) => m.role === "user" || (m.role === "assistant" && (m.content || m.error)));
    box.innerHTML = (visible.length ? "" : `<div class="msg ai"><p>Hi! I can search the ${P.model.courses.length} courses, explain what each one teaches, and build your plan with the optimiser. Tell me what you're into, or try one of these:</p></div>`) +
      visible.map((m) => m.role === "user" ? `<div class="msg user">${esc(m.content)}</div>`
        : m.error ? `<div class="msg err">${esc(m.error)}</div>` : `<div class="msg ai">${markdown(m.content)}</div>`).join("") +
      (thinking ? `<div class="msg ai"><div class="steps">${(steps || []).map((s) => `<span class="stepchip">${esc(s)}</span>`).join("")}<span class="stepchip"><span class="spin" aria-hidden="true"></span> thinking</span></div></div>` : "");
    box.scrollTop = box.scrollHeight;
    const sug = $("suggest");
    if (sug) sug.hidden = visible.length > 0;
  }
  function renderChat() {
    $("dock").innerHTML = `<div class="dock-hd"><h3>AI advisor</h3><span class="tag" title="${esc(store.get(MODEL))}">${esc((store.get(MODEL) || "").split("/").pop())}</span><span class="grow"></span>
        <button class="btn ghost small" id="advSettings" type="button">Settings</button><button class="btn ghost small" id="advClose" type="button" aria-label="Close advisor">✕</button></div>
      <div class="msgs" id="msgs" aria-live="polite"></div>
      <div class="composer"><div class="suggest" id="suggest">${SUGGESTIONS.map((s) => `<button type="button">${esc(s)}</button>`).join("")}</div>
        <form id="advForm"><textarea id="advInput" rows="1" placeholder="Ask about courses or say what you want…" aria-label="Message"></textarea><button class="btn primary" type="submit">Send</button></form></div>`;
    renderMessages(busy);
    $("advInput").focus();
  }
  async function renderSetup(error) {
    const key = store.get(KEY);
    $("dock").innerHTML = `<div class="dock-hd"><h3>AI advisor</h3><span class="grow"></span><button class="btn ghost small" id="advClose" type="button" aria-label="Close advisor">✕</button></div>
      <form class="setup" id="advSetup">
        <p>The advisor talks to an AI model through <a href="https://openrouter.ai" target="_blank" rel="noopener">OpenRouter</a>. It searches the catalogue, reads syllabi, edits your shortlist and runs the optimiser for you.</p>
        <label>OpenRouter API key<input type="password" id="advKey" autocomplete="off" spellcheck="false" placeholder="sk-or-…" value="${key ? "••••••••" : ""}"></label>
        <label>Model<select id="advModel"><option>Loading models…</option></select></label>
        ${error ? `<p class="warn">${esc(error)}</p>` : ""}
        <div class="row between"><button class="btn primary" type="submit">Start</button>${key ? '<button class="btn ghost small" type="button" id="advForget">Forget my key</button>' : ""}</div>
        <p class="note">Your key stays in this browser (localStorage) and is sent only to openrouter.ai, never to this site. Create one at openrouter.ai/keys and set a spending limit. Don't save it on a shared computer.</p>
        <p class="note">No key? <a href="#" id="advWizard">Plan it for me</a> works without one.</p>
      </form>`;
    try {
      const list = await loadModels();
      const current = store.get(MODEL) || (list[0] && list[0].id);
      $("advModel").innerHTML = list.slice(0, 80).map((m) => `<option value="${esc(m.id)}" ${m.id === current ? "selected" : ""}>${esc(m.name || m.id)}</option>`).join("");
    } catch (e) {
      $("advModel").innerHTML = `<option value="">Couldn't load the model list</option>`;
    }
  }
  function open() {
    $("dock").hidden = false;
    if (store.get(KEY) && store.get(MODEL)) renderChat(); else renderSetup();
  }

  $("dock").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (e.target.id === "advSetup") {
      const typed = $("advKey").value.trim();
      if (typed && !typed.startsWith("••")) store.set(KEY, typed);
      if ($("advModel").value) store.set(MODEL, $("advModel").value);
      if (!store.get(KEY)) return renderSetup("Paste a key first.");
      if (!store.get(MODEL)) return renderSetup("Pick a model.");
      renderChat();
    } else if (e.target.id === "advForm") {
      const input = $("advInput"), text = input.value;
      input.value = "";
      await send(text);
    }
  });
  $("dock").addEventListener("keydown", (e) => {
    if (e.target.id === "advInput" && e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("advForm").requestSubmit(); }
  });
  $("dock").addEventListener("input", (e) => {
    if (e.target.id === "advInput") { e.target.style.height = "auto"; e.target.style.height = Math.min(140, e.target.scrollHeight) + "px"; }
  });
  $("dock").addEventListener("click", (e) => {
    if (e.target.closest("#advClose")) { $("dock").hidden = true; return; }
    if (e.target.closest("#advSettings")) { renderSetup(); return; }
    if (e.target.closest("#advForget")) { store.set(KEY, null); history = []; saveHistory(); renderSetup(); P.toast("Key removed from this browser"); return; }
    if (e.target.closest("#advWizard")) { e.preventDefault(); $("dock").hidden = true; $("openWizard").click(); return; }
    const s = e.target.closest("#suggest button");
    if (s) send(s.textContent);
  });
  ["openAdvisor", "heroAdvisor"].forEach((id) => $(id).addEventListener("click", () => ($("dock").hidden ? open() : ($("dock").hidden = true))));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("dock").hidden && $("drawer").hidden) $("dock").hidden = true; });
})();
