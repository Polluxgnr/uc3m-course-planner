"""Insight generation with a fake model client (no network)."""

import json
import os

import pytest

from uc3m_planner.insights import attach, course_key, generate, load_env, parse_insight, prompt_for

COURSE = {
    "id": 0, "n": "Mobile Applications", "fam": "aplicaciones moviles", "e": 6.0, "y": [3], "dept": "Telematics",
    "req": "Programming", "obj": "Design Android apps.", "cont": "1. Android UI", "as": "Project 70%, exam 30%",
    "m": 2.1, "h": 4.9, "a": 4.2, "ex": 30,
}  # fmt: skip
REPLY = {
    "summary": "Build Android apps end to end.",
    "learn": ["Design UIs", "Call REST APIs"],
    "useful": ["Mobile developer"],
    "tools": ["Kotlin"],
    "watch": "",
}


def test_parse_insight_accepts_wrapped_json_and_trims_lists():
    text = "Sure! ```json\n" + json.dumps({**REPLY, "learn": [f"skill {i}" for i in range(9)]}) + "\n```"
    out = parse_insight(text)
    assert out["summary"] == REPLY["summary"]
    assert len(out["learn"]) == 5
    assert out["tools"] == ["Kotlin"]


@pytest.mark.parametrize("text", ["no json here", json.dumps({"summary": "", "learn": ["x"]}), json.dumps({"summary": "x", "learn": []})])
def test_parse_insight_rejects_incomplete_replies(text):
    with pytest.raises(ValueError):
        parse_insight(text)


def test_prompt_contains_syllabus_fields():
    prompt = prompt_for(COURSE)
    for needle in ("Mobile Applications", "Design Android apps.", "1. Android UI", "Final exam 30%"):
        assert needle in prompt


class FakeClient:
    model = "fake/model"

    def __init__(self, replies):
        self.replies, self.calls = list(replies), 0

    def complete(self, prompt):
        self.calls += 1
        return self.replies.pop(0)


def test_generate_retries_bad_reply_and_caches(tmp_path):
    client = FakeClient(["not json", json.dumps(REPLY)])
    out = generate({"courses": [COURSE]}, client, tmp_path, workers=1)
    assert out == {course_key(COURSE): parse_insight(json.dumps(REPLY))}
    assert client.calls == 2
    again = FakeClient([])
    assert generate({"courses": [COURSE]}, again, tmp_path, workers=1) == out
    assert again.calls == 0, "second run is served from the cache"


def test_attach_sets_field_by_family_and_ects():
    data = {"courses": [dict(COURSE), {**COURSE, "e": 3.0}]}
    attach(data, {course_key(COURSE): REPLY})
    assert data["courses"][0]["ins"] == REPLY
    assert "ins" not in data["courses"][1]


def test_load_env_does_not_override_existing(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text("# comment\nUC3M_TEST_A='from-file'\nUC3M_TEST_B=file\n", encoding="utf-8")
    monkeypatch.setenv("UC3M_TEST_B", "from-env")
    monkeypatch.delenv("UC3M_TEST_A", raising=False)
    load_env(env)
    assert os.environ["UC3M_TEST_A"] == "from-file"
    assert os.environ["UC3M_TEST_B"] == "from-env"
