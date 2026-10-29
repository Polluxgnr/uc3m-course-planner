"""AI course insights: a short, student-facing summary of each syllabus, generated once with an LLM.

Reads data/dataset.json, asks a model on OpenRouter for structured JSON per course and writes
data/insights.json (keyed by course family + ECTS). Results are cached per input hash, so re-runs
only pay for courses whose syllabus changed. The key comes from OPENROUTER_API_KEY (environment or
a local .env file) and is never written anywhere.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

log = logging.getLogger(__name__)
API = "https://openrouter.ai/api/v1"
PREFERRED_MODELS = ("anthropic/claude-sonnet", "anthropic/claude", "openai/gpt", "google/gemini")

PROMPT = """You help exchange students choose engineering courses at UC3M (Madrid).
From the official syllabus excerpt below, write a concise, honest, student-facing summary.
Return ONLY a JSON object with these keys:
  "summary": one or two plain sentences on what the course is about and its angle (max 45 words),
  "learn": 3 to 5 concrete things a student will be able to do afterwards (each max 12 words),
  "useful": 2 to 4 concrete uses: skills, roles or follow-up fields it prepares for (each max 10 words),
  "tools": up to 5 named tools, languages or methods used in the course (only if named or clearly implied, else []),
  "watch": one short heads-up about difficulty, prerequisites or assessment (max 25 words), or "" if nothing notable.
Do not invent facts that the syllabus doesn't support. Write in English even if the syllabus is in Spanish.

Course: {name} ({ects} ECTS, year {year}, {dept})
Assumed knowledge: {req}
Objectives: {obj}
Contents: {cont}
Assessment: {assess}
Heuristic scores (1-5, relative): maths {m}, hands-on {h}, AI & software {a}. Final exam {ex}% of the grade.
"""


def load_env(path: Path) -> None:
    """Minimal .env reader: KEY=VALUE lines, existing environment variables win."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip("'\""))


def course_key(course: dict) -> str:
    return f"{course['fam']}|{course['e']}"


def prompt_for(course: dict) -> str:
    return PROMPT.format(
        name=course["n"],
        ects=course["e"],
        year=", ".join(map(str, course["y"])) or "?",
        dept=course.get("dept") or "?",
        req=course.get("req") or "-",
        obj=course.get("obj") or "-",
        cont=course.get("cont") or "-",
        assess=(course.get("as") or "-")[:500],
        m=course["m"],
        h=course["h"],
        a=course["a"],
        ex=course["ex"] if course.get("ex") is not None else "?",
    )


def parse_insight(text: str) -> dict:
    """Extract and validate the JSON object from a model reply."""
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("no JSON object in reply")
    raw = json.loads(text[start : end + 1])

    def strings(value, limit):
        return [str(x).strip() for x in value if str(x).strip()][:limit] if isinstance(value, list) else []

    out = {
        "summary": str(raw.get("summary", "")).strip(),
        "learn": strings(raw.get("learn"), 5),
        "useful": strings(raw.get("useful"), 4),
        "tools": strings(raw.get("tools"), 5),
        "watch": str(raw.get("watch", "") or "").strip(),
    }
    if not out["summary"] or not out["learn"]:
        raise ValueError("summary or learn missing")
    return out


class OpenRouter:
    def __init__(self, key: str, model: str | None = None, timeout: float = 90):
        self.session = requests.Session()
        self.session.headers.update({"Authorization": f"Bearer {key}", "X-Title": "UC3M Course Planner (insights)"})
        self.timeout = timeout
        self.model = model or self.pick_model()

    def pick_model(self) -> str:
        models = self.session.get(f"{API}/models", timeout=self.timeout).json()["data"]
        ranked = sorted(models, key=lambda m: (next((i for i, p in enumerate(PREFERRED_MODELS) if m["id"].startswith(p)), 99), -m.get("created", 0)))
        return ranked[0]["id"]

    def complete(self, prompt: str) -> str:
        for attempt in range(4):
            resp = self.session.post(
                f"{API}/chat/completions",
                json={
                    "model": self.model,
                    "temperature": 0.2,
                    "response_format": {"type": "json_object"},
                    "messages": [{"role": "user", "content": prompt}],
                },
                timeout=self.timeout,
            )
            if resp.status_code in (429, 500, 502, 503) and attempt < 3:
                time.sleep(3 * (attempt + 1))
                continue
            resp.raise_for_status()
            return resp.json()["choices"][0]["message"]["content"]
        raise RuntimeError("unreachable")


def generate(dataset: dict, client: OpenRouter, cache_dir: Path, workers: int = 4) -> dict[str, dict]:
    """Insights for every course, using and filling the per-prompt cache."""
    cache_dir.mkdir(parents=True, exist_ok=True)

    def one(course: dict) -> tuple[str, dict | None]:
        prompt = prompt_for(course)
        path = cache_dir / (hashlib.sha256(f"{client.model}\n{prompt}".encode()).hexdigest()[:24] + ".json")
        if path.exists():
            return course_key(course), json.loads(path.read_text(encoding="utf-8"))
        for _ in range(2):
            try:
                insight = parse_insight(client.complete(prompt))
                path.write_text(json.dumps(insight, ensure_ascii=False), encoding="utf-8")
                return course_key(course), insight
            except (ValueError, KeyError, requests.RequestException) as exc:
                log.warning("insight for %s failed: %s", course["n"], exc)
        return course_key(course), None

    with ThreadPoolExecutor(workers) as pool:
        results = dict(pool.map(one, dataset["courses"]))
    done = {k: v for k, v in results.items() if v}
    log.info("insights for %d/%d courses with %s", len(done), len(results), client.model)
    return done


def attach(dataset: dict, insights: dict[str, dict]) -> dict:
    """Copy each course's insight into the dataset (field "ins")."""
    for course in dataset["courses"]:
        ins = insights.get(course_key(course))
        if ins:
            course["ins"] = ins
    return dataset
