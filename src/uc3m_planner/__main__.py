"""Command line: python -m uc3m_planner {scrape,syllabi,dataset,site,all} [--refresh]."""

from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path

from .dataset import build
from .http import Fetcher
from .scrape import scrape_syllabi, scrape_timetables
from .site import build_site

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / ".cache"
TIMETABLES = CACHE / "timetables.json"  # raw crawl output (large, not versioned)
SYLLABI = CACHE / "syllabi.json"  # full syllabus text (UC3M's content, not versioned)
DATASET = ROOT / "data" / "dataset.json"  # what the web app ships with (versioned)


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
    parser.add_argument("step", choices=["scrape", "syllabi", "dataset", "site", "all"])
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
    if "site" in steps:
        for path in build_site(ROOT / "web", DATASET, ROOT / "dist"):
            logging.info("wrote %s", path.relative_to(ROOT))


if __name__ == "__main__":
    main()
