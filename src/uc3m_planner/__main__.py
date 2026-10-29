"""Command line: python -m uc3m_planner {scrape,syllabi,dataset,insights,site,all} [--refresh]."""

from __future__ import annotations

import argparse
import json
import logging
import os
from pathlib import Path

from .dataset import build
from .http import Fetcher
from .insights import OpenRouter, generate, load_env
from .scrape import scrape_syllabi, scrape_timetables
from .site import build_site

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / ".cache"
TIMETABLES = CACHE / "timetables.json"  # raw crawl output (large, not versioned)
SYLLABI = CACHE / "syllabi.json"  # full syllabus text (UC3M's content, not versioned)
DATASET = ROOT / "data" / "dataset.json"  # what the web app ships with (versioned)
INSIGHTS = ROOT / "data" / "insights.json"  # AI summaries per course (versioned)


def _dump(obj: dict, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
    logging.info("wrote %s", path.relative_to(ROOT))


def _load(path: Path) -> dict:
    if not path.exists():
        raise SystemExit(f"{path.relative_to(ROOT)} is missing: run the previous step first")
    return json.loads(path.read_text(encoding="utf-8"))


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="uc3m_planner", description=__doc__)
    parser.add_argument("step", choices=["scrape", "syllabi", "dataset", "insights", "site", "all"])
    parser.add_argument("--model", help="OpenRouter model id for insights (default: best available Claude model)")
    parser.add_argument("--refresh", action="store_true", help="ignore the HTTP cache and re-download")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(levelname)s %(message)s")
    fetcher = Fetcher(CACHE / "http", refresh=args.refresh)
    steps = ["scrape", "syllabi", "dataset", "site"] if args.step == "all" else [args.step]

    if "scrape" in steps:
        _dump(scrape_timetables(fetcher), TIMETABLES)
    if "syllabi" in steps:
        _dump(scrape_syllabi(fetcher, _load(TIMETABLES)), SYLLABI)
    if "dataset" in steps:
        data = build(_load(TIMETABLES), _load(SYLLABI))
        _dump(data, DATASET)
        logging.info("%d courses, %d groups", len(data["courses"]), sum(len(c["groups"]) for c in data["courses"]))
    if "insights" in steps:
        load_env(ROOT / ".env")
        key = os.environ.get("OPENROUTER_API_KEY")
        if not key:
            raise SystemExit("Set OPENROUTER_API_KEY in the environment or in .env (see .env.example)")
        client = OpenRouter(key, args.model or os.environ.get("OPENROUTER_MODEL"))
        _dump(generate(_load(DATASET), client, CACHE / "insights"), INSIGHTS)
    if "site" in steps:
        for path in build_site(ROOT / "web", DATASET, ROOT / "dist", INSIGHTS):
            logging.info("wrote %s", path.relative_to(ROOT))


if __name__ == "__main__":
    main()
