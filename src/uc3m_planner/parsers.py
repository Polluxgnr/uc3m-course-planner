"""Pure HTML -> data parsers for the three kinds of UC3M pages. No network access here."""

from __future__ import annotations

import re
from urllib.parse import parse_qs, urljoin, urlparse

from bs4 import BeautifulSoup, Tag

from .config import TIMETABLES, UC3M

DAYS = {"LUNES": "Mon", "MARTES": "Tue", "MIERCOLES": "Wed", "MIÉRCOLES": "Wed", "JUEVES": "Thu", "VIERNES": "Fri", "SABADO": "Sat", "SÁBADO": "Sat"}


def clean(text: str | None) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def _query(href: str) -> dict[str, str]:
    return {k: v[0] for k, v in parse_qs(urlparse(href).query).items()}


# --- degree page (uc3m.es/bachelor-degree/<slug>) ---------------------------------------------------
def parse_degree_page(html: str) -> tuple[dict[str, dict], list[tuple[str, str]]]:
    """Return ({subject code: study-plan info}, [(timetable plan, centre)])."""
    soup = BeautifulSoup(html, "lxml")
    subjects: dict[str, dict] = {}
    for tab in ("program_currentprogram", "program_previousprogram", None):
        scope = soup.find("li", id=tab) if tab else soup
        if not scope:
            continue
        heading = ""
        for el in scope.find_all(["h3", "table"]):
            if el.name == "h3":
                heading = clean(el.get_text())
                continue
            caption = clean(el.caption.get_text()) if el.caption else ""
            for row in el.find_all("tr"):
                info = _plan_row(row, heading, caption)
                if info:
                    subjects.setdefault(info["code"], info)
    plans: list[tuple[str, str]] = []
    for a in soup.find_all("a", href=re.compile(r"horarios-web/publicacion/plan\.page")):
        q = _query(a["href"])
        plan = (q["plan"], q["centro"])
        if plan not in plans:
            plans.append(plan)
    return subjects, plans


def _plan_row(row: Tag, heading: str, caption: str) -> dict | None:
    link = row.find("a", href=re.compile(r"generaFicha"))
    if not link:
        return None
    q = _query(link["href"])
    cells = {td.get("data-label", "").upper(): clean(td.get_text()) for td in row.find_all("td")}
    try:
        ects = float(cells.get("ECTS", "").replace(",", "."))
    except ValueError:
        ects = None
    return {
        "code": q.get("asig", ""),
        "name": clean(link.get_text()),
        "ects": ects,
        "type": cells.get("TYPE", ""),
        "lang": [img["alt"] for img in row.find_all("img") if img.get("alt")],
        "where": heading,
        "elective": "lective" in caption,
        "syllabus": urljoin(UC3M, link["href"]),
    }


# --- timetable plan page (one degree, one semester) --------------------------------------------------
def parse_plan_page(html: str, semester: int) -> tuple[str, list[dict]]:
    """Return (page title, [subjects taught that semester])."""
    soup = BeautifulSoup(html, "lxml")
    title_el = soup.find(id="nombreApp")
    title = clean(title_el.get_text()) if title_el else ""
    out = []
    for a in soup.find_all("a", class_="asignatura-link"):
        q = _query(a["href"])
        block = a.find_previous("h4", class_="asignatura-curso-title")
        m = re.match(r"(\d+)\s*-\s*(.*)", clean(a.get_text()))
        out.append(
            {
                "code": q["asignatura"],
                "name_es": m.group(2) if m else clean(a.get_text()),
                "block": clean(block.get_text()) if block else "",
                "url": urljoin(TIMETABLES, a["href"]).replace("valorPer=1", f"valorPer={semester}"),
            }
        )
    return title, out


def campus_of(title: str) -> str:
    m = re.search(r"\(([^)]+)\)\s*$", title)
    return m.group(1) if m else ""


# --- subject timetable grid --------------------------------------------------------------------------
def parse_subject_timetable(html: str) -> list[dict]:
    """Flatten the weekly grid (rowspans/colspans) into sessions with day, time, group and dates."""
    soup = BeautifulSoup(html, "lxml")
    table = soup.find("table", class_="timetable")
    if not table or not table.find("thead") or not table.find("tbody"):
        return []
    col_day: list[str | None] = []
    for th in table.find("thead").find_all("th"):
        col_day += [DAYS.get(clean(th.get_text()).upper())] * int(th.get("colspan", 1))
    occupied: set[tuple[int, int]] = set()
    sessions, seen = [], set()
    for r, tr in enumerate(table.find("tbody").find_all("tr", recursive=False)):
        c = 0
        for cell in tr.find_all(["td", "th"], recursive=False):
            while (r, c) in occupied:
                c += 1
            rs, cs = int(cell.get("rowspan", 1)), int(cell.get("colspan", 1))
            occupied.update((rr, cc) for rr in range(r, r + rs) for cc in range(c, c + cs))
            day = col_day[c] if c < len(col_day) else None
            if "celdaConSesion" in (cell.get("class") or []) and day:
                s = _session(cell, day)
                key = s and (s["day"], s["start"], s["end"], s["kind"], s["group"])
                if s and key not in seen:
                    seen.add(key)
                    sessions.append(s)
            c += cs
    return sessions


def _session(cell: Tag, day: str) -> dict | None:
    text = cell.get_text("\n")
    tm = re.search(r"(\d{1,2}:\d{2})\s*a\s*(\d{1,2}:\d{2})", text)
    if not tm:
        return None
    main = cell.find(class_="asignaturaAgrupacion")
    grp = re.search(r"grp\.\s*(\w+)", main.get_text() if main else text)
    return {
        "day": day,
        "start": tm.group(1).zfill(5),
        "end": tm.group(2).zfill(5),
        "kind": clean(cell.find("div").get_text()) if cell.find("div") else "",
        "group": grp.group(1) if grp else "?",
        "dates": [clean(f.get_text()).rstrip(":") for f in cell.find_all(class_="fechas")],
        "rooms": sorted({clean(a.get_text()) for a in cell.find_all(class_="aulas")}),
    }


# --- syllabus (ficha) ---------------------------------------------------------------------------------
SECTIONS = [
    ("req", r"Requirements \(Subjects that are assumed to be known\)|Requisitos \(Asignaturas o materias cuyo conocimiento se presupone\)"),
    ("obj", r"\nObjectives\n|\nObjetivos\n"),
    ("cont", r"Description of contents: programme|Descripción de contenidos: programa"),
    ("meth", r"Learning activities and methodology|Actividades formativas, metodología a utilizar y régimen de tutorías"),
    ("assess", r"Assessment System|Sistema de evaluación"),
    ("end", r"Basic Bibliography|Bibliografía básica|Extraordinary call: regulations|Convocatoria extraordinaria: normativa"),
]


def parse_syllabus(html: str) -> dict:
    """Split a syllabus into its sections and pull out the exam / continuous-assessment split."""
    text = BeautifulSoup(html, "lxml").get_text("\n")
    text = re.sub(r"\n\s*\n+", "\n", re.sub(r"[ \t\r\xa0]+", " ", text))
    marks = sorted((m.start(), m.end(), key) for key, pat in SECTIONS if (m := re.search(pat, text)))
    out: dict = {}
    for i, (_, end, key) in enumerate(marks):
        stop = marks[i + 1][0] if i + 1 < len(marks) else len(text)
        if key != "end":
            out[key] = text[end:stop].strip()
    assess = out.get("assess", "")
    exam = re.search(r"% (?:end-of-term-examination/test|examen final)\s*(\d+)", assess, re.I)
    cont = re.search(r"% (?:of continuous assessment|de evaluación continua)[^\d]*(\d+)", assess, re.I)
    out["exam_pct"] = int(exam.group(1)) if exam else None
    out["cont_pct"] = int(cont.group(1)) if cont else None
    for key, pat in (
        ("coord", r"(?:Coordinating teacher|Profesor coordinador):\s*\n?(.+)"),
        ("dept", r"(?:Department assigned to the subject|Departamento asignado a la asignatura):\s*\n?(.+)"),
    ):
        m = re.search(pat, text)
        out[key] = m.group(1).strip() if m else ""
    out["lang_page"] = "en" if "Assessment System" in text else "es"
    return out
