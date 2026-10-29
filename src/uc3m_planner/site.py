"""Bundle web/ + the dataset into self-contained HTML files (no server, no build tooling)."""

from __future__ import annotations

import json
import re
from pathlib import Path

from .insights import attach

DOC_HEAD = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
"""


def _inline(page: str, web: Path, dataset: dict) -> str:
    def css(_: re.Match) -> str:
        return "<style>\n" + (web / "styles.css").read_text(encoding="utf-8") + "</style>"

    def script(m: re.Match) -> str:
        name = m.group(1)
        body = (web / name).read_text(encoding="utf-8")
        ident = f' id="{Path(name).stem}-src"' if name == "engine.js" else ""
        return f"<script{ident}>\n{body}</script>"

    data = json.dumps(dataset, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    page = re.sub(r'<link rel="stylesheet" href="styles\.css">', css, page)
    page = page.replace('<script src="dataset.js"></script>', f"<script>window.DATASET = {data};</script>")
    return re.sub(r'<script src="([\w.]+\.js)"></script>', script, page)


def build_site(web: Path, dataset_path: Path, out_dir: Path, insights_path: Path | None = None) -> list[Path]:
    """Write dist/planner.html (page fragment, as the artifact host expects) and dist/index.html (full document)."""
    dataset = json.loads(dataset_path.read_text(encoding="utf-8"))
    if insights_path and insights_path.exists():
        attach(dataset, json.loads(insights_path.read_text(encoding="utf-8")))
    fragment = _inline((web / "index.html").read_text(encoding="utf-8"), web, dataset)
    out_dir.mkdir(parents=True, exist_ok=True)
    frag_path, doc_path = out_dir / "planner.html", out_dir / "index.html"
    frag_path.write_text(fragment, encoding="utf-8")
    doc_path.write_text(DOC_HEAD + fragment.replace("</style>", "</style>\n</head>\n<body>", 1) + "\n</body>\n</html>\n", encoding="utf-8")
    return [frag_path, doc_path]
