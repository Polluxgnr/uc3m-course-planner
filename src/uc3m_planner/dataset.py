"""Turn scraped timetables + syllabi into the compact, scored dataset the web app loads."""

from __future__ import annotations

import collections
import datetime as dt
import re
import unicodedata

from . import config
from .scoring import deadlines, rank_scale, raw_scores

MONTHS = {"ene": 1, "feb": 2, "mar": 3, "abr": 4, "may": 5, "jun": 6, "jul": 7, "sep": 9, "oct": 10, "nov": 11, "dic": 12}
DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
KIND_LAB, KIND_LECTURE = "P", "T"


def norm(text: str) -> str:
    """Accent-free, lower-case, punctuation-free key (also drops parenthesised suffixes)."""
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", " ", re.sub(r"\(.*?\)", " ", text)).strip()


def day_number(token: str, epoch: dt.date = config.EPOCH) -> int:
    """'01.feb' -> days since the epoch (the semester's calendar year)."""
    day, month = token.split(".")
    return (dt.date(epoch.year, MONTHS[month[:3].lower()], int(day)) - epoch).days


def date_ranges(dates: list[str]) -> list[list[int]]:
    """['01.feb-15.mar', '07.may'] -> [[31, 73], [126, 126]]; whole semester if unparseable."""
    out = []
    for item in dates:
        parts = item.split("-")
        try:
            out.append([day_number(parts[0]), day_number(parts[-1])])
        except (KeyError, ValueError):
            continue
    first = config.CALENDAR["first_monday"]
    return out or [[first, first + 7 * config.CALENDAR["calendar_weeks"]]]


def minutes(hhmm: str) -> int:
    hours, mins = hhmm.split(":")
    return int(hours) * 60 + int(mins)


def is_skills_course(name: str, name_es: str, ects: float) -> bool:
    return ects < 3 or any(re.search(p, f"{name} {name_es}", re.I) for p in config.SKILLS_PATTERNS)


def clip(text: str, limit: int) -> str:
    text = (text or "").strip()
    return text if len(text) <= limit else text[:limit].rsplit(" ", 1)[0] + " …"


def _sessions(raw: list[dict]) -> list[list]:
    """Session rows as [day, start, end, kind, [[from, to], ...], rooms]; resit slots dropped."""
    rows = []
    for x in raw:
        kind = x["kind"].upper()
        if x["day"] not in DAYS or "RECUP" in kind:
            continue
        rows.append(
            [
                DAYS.index(x["day"]),
                minutes(x["start"]),
                minutes(x["end"]),
                KIND_LAB if kind.startswith("PR") else KIND_LECTURE,
                date_ranges(x["dates"]),
                ", ".join(x["rooms"]),
            ]
        )
    return sorted(rows)


def lab_share(groups: list[dict]) -> float:
    total = lab = 0
    for g in groups:
        for _day, start, end, kind, ranges, _ in g["s"]:
            weight = sum((b - a) // 7 + 1 for a, b in ranges) * (end - start)
            total += weight
            lab += weight if kind == KIND_LAB else 0
    return lab / total if total else 0.0


def build(timetables: dict, syllabi: dict) -> dict:
    """Merge the same course across degrees (same Spanish name and ECTS) and score it."""
    merged: dict[tuple, dict] = {}
    for s in timetables["subjects"]:
        if not s["sessions"] or s["campus"] != config.CAMPUS or not s["ects"]:
            continue
        c = merged.setdefault(
            (norm(s["name_es"]), s["ects"]),
            {
                "names": collections.Counter(),
                "es": s["name_es"],
                "e": s["ects"],
                "l": set(),
                "y": set(),
                "dg": set(),
                "el": False,
                "syls": [],
                "codes": set(),
                "groups": {},
            },
        )
        c["names"][s["name"]] += 2 if "English" in s["lang"] else 1
        c["l"].update(s["lang"])
        c["dg"].add(s["degree"])
        c["el"] |= s["elective"]
        c["codes"].add(s["code"])
        if year := re.search(r"(\d)", s["block"]):
            c["y"].add(int(year.group(1)))
        if s["syllabus"]:
            c["syls"].append((s["syllabus"], "English" in s["lang"]))
        by_group = collections.defaultdict(list)
        for x in s["sessions"]:
            by_group[x["group"]].append(x)
        for gid, raw in by_group.items():
            rows = _sessions(raw)
            if not rows:
                continue
            sig = repr([r[:5] for r in rows])
            g = c["groups"].setdefault((gid, sig), {"g": gid, "deg": set(), "code": set(), "l": set(), "s": rows})
            g["deg"].add(s["degree"])
            g["l"].update(s["lang"])  # languages of the degree variants this group teaches
            g["code"].add(s["code"])

    items = []
    for c in merged.values():
        if not c["groups"]:
            continue
        # prefer the syllabus of an English-taught variant, then one with an assessment split
        ranked = sorted(
            c["syls"],
            key=lambda u: (u[1], syllabi.get(u[0], {}).get("lang_page") == "en", syllabi.get(u[0], {}).get("exam_pct") is not None),
            reverse=True,
        )
        c["syl_url"] = ranked[0][0] if ranked else ""
        c["sy"] = syllabi.get(c["syl_url"], {})
        c["groups"] = sorted(c["groups"].values(), key=lambda g: g["g"])
        c["lab"] = lab_share(c["groups"])
        c["raw"] = raw_scores(c["sy"], c["lab"])
        items.append(c)
    for i, key in enumerate(("m", "h", "a")):
        for c, value in zip(items, rank_scale([c["raw"][i] for c in items]), strict=True):
            c[key] = value

    courses = []
    for c in sorted(items, key=lambda c: c["names"].most_common(1)[0][0].lower()):
        sy, name = c["sy"], c["names"].most_common(1)[0][0]
        courses.append(
            {
                "id": len(courses),
                "n": name,
                "es": c["es"],
                "fam": norm(c["es"]),
                "e": c["e"],
                "l": sorted(c["l"]),
                "y": sorted(c["y"]),
                "dg": sorted(c["dg"]),
                "el": c["el"],
                "syl": c["syl_url"],
                "codes": sorted(c["codes"]),
                "rec": norm(c["es"]) in config.STARTER_PICKS,
                "skills": is_skills_course(name, c["es"], c["e"]),
                "m": c["m"],
                "h": c["h"],
                "a": c["a"],
                "lab": round(c["lab"], 2),
                "ex": sy.get("exam_pct"),
                "co": sy.get("cont_pct"),
                "wk": deadlines(sy.get("assess", "")),
                "dept": sy.get("dept", ""),
                "req": clip(sy.get("req", ""), 220),
                "obj": clip(sy.get("obj", ""), 420),
                "cont": clip(sy.get("cont", ""), 700),
                "as": clip(sy.get("assess", ""), 1100),
                "groups": [{"g": g["g"], "deg": sorted(g["deg"]), "code": sorted(g["code"]), "l": sorted(g["l"]), "s": g["s"]} for g in c["groups"]],
            }
        )
    return {
        "scraped": timetables["scraped"],
        "year": f"{config.ACADEMIC_YEAR}/{(config.ACADEMIC_YEAR + 1) % 100:02d}",
        "semester": config.SEMESTER,
        "campus": config.CAMPUS,
        "calendar": config.CALENDAR,
        "degrees": {k: v["name"] for k, v in timetables["degrees"].items()},
        "courses": courses,
    }
