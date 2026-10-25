"""Crawl degree pages -> timetable plans -> subject timetables, then the syllabi."""

from __future__ import annotations

import logging
import time
from functools import partial

from . import config
from .http import Fetcher
from .parsers import campus_of, parse_degree_page, parse_plan_page, parse_subject_timetable, parse_syllabus

log = logging.getLogger(__name__)


def scrape_timetables(fetcher: Fetcher) -> dict:
    """Every subject taught in the configured semester, with its study-plan info and sessions."""
    degree_urls = {slug: f"{config.UC3M}/bachelor-degree/{slug}" for slug in config.DEGREES}
    pages = fetcher.map(parse_degree_page, degree_urls.values())
    degrees, jobs = {}, []
    for slug, url in degree_urls.items():
        subjects, plans = pages[url]
        plans += [p for p in config.EXTRA_PLANS.get(slug, []) if p not in plans]
        degrees[slug] = {"name": config.DEGREES[slug], "plans": plans}
        log.info("%-28s %3d plan subjects, timetable plans %s", slug, len(subjects), plans)
        jobs += [(slug, plan, centre) for plan, centre in plans]

    plan_url = "{}/horarios-web/publicacion/plan.page?plan={}&centro={}&cuat={}"
    urls = {job: plan_url.format(config.TIMETABLES, job[1], job[2], config.SEMESTER) for job in jobs}
    plan_pages = fetcher.map(partial(parse_plan_page, semester=config.SEMESTER), urls.values())

    subjects = []
    for (slug, plan, centre), url in urls.items():
        title, entries = plan_pages[url]
        if any(marker in title for marker in config.SKIP_PLAN_TITLES):
            log.info("skipping plan %s/%s: %s", plan, centre, title)
            continue
        info = pages[degree_urls[slug]][0]
        for entry in entries:
            meta = info.get(entry["code"], {})
            subjects.append(
                {
                    **entry,
                    "degree": slug,
                    "plan": plan,
                    "centro": centre,
                    "campus": campus_of(title),
                    "plan_title": title,
                    "name": meta.get("name") or entry["name_es"],
                    "ects": meta.get("ects"),
                    "type": meta.get("type", ""),
                    "lang": meta.get("lang", []),
                    "where": meta.get("where", ""),
                    "elective": meta.get("elective", False),
                    "syllabus": meta.get("syllabus", ""),
                    "in_plan": bool(meta),
                }
            )
    log.info("%d subject entries; fetching their timetables", len(subjects))
    timetables = fetcher.map(parse_subject_timetable, (s["url"] for s in subjects))
    for s in subjects:
        s["sessions"] = timetables[s["url"]]
    return {"scraped": time.strftime("%Y-%m-%d"), "semester": config.SEMESTER, "degrees": degrees, "subjects": subjects}


def scrape_syllabi(fetcher: Fetcher, timetables: dict) -> dict:
    urls = sorted({s["syllabus"] for s in timetables["subjects"] if s["syllabus"]})
    log.info("fetching %d syllabi", len(urls))
    out = fetcher.map(parse_syllabus, urls)
    missing = sum(1 for v in out.values() if v.get("exam_pct") is None)
    log.info("%d syllabi without an assessment split", missing)
    return out
