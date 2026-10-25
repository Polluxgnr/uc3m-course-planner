"""Everything that changes from one academic year to the next lives here."""

from __future__ import annotations

import datetime as dt

# --- sources -------------------------------------------------------------------------------------
UC3M = "https://www.uc3m.es"
TIMETABLES = "https://aplicaciones.uc3m.es"

ACADEMIC_YEAR = 2026  # 2026/27
SEMESTER = 2
CAMPUS = "Leganés"

# Bachelors of the School of Engineering (EPS) open to exchange students.
# Dual bachelors and Bachelor + Master tracks are excluded on purpose.
DEGREES: dict[str, str] = {
    "data-science": "Data Science and Engineering",
    "sciences": "Sciences",
    "eletrical": "Electrical Power Engineering (Dual Mention)",
    "electronic": "Industrial Electronics and Automation Engineering",
    "physics-engineering": "Engineering Physics",
    "aeroespace": "Aerospace Engineering",
    "sound-image": "Sound and Image Engineering",
    "computer-science": "Computer Science and Engineering",
    "artificial-intelligence": "Artificial Intelligence",
    "mathematics-applied": "Applied Mathematics",
    "mathematics-computing": "Mathematics and Computing",
    "mechanical": "Mechanical Engineering",
    "robotics": "Robotics Engineering",
    "telematics": "Internet Engineering",
    "biomedical": "Biomedical Engineering",
    "industrial-technologies": "Industrial Technologies Engineering",
    "telecommunication": "Telecommunication Technologies Engineering",
    "energy": "Energy Engineering",
    "mobile-space-communications": "Mobile and Space Communications Engineering",
}

# Timetable plans the degree pages don't link (or link wrongly), found in the timetable index.
EXTRA_PLANS: dict[str, list[tuple[str, str]]] = {
    "eletrical": [("598", "2"), ("443", "2")],
    "robotics": [("597", "2")],
    "telecommunication": [("445", "2"), ("238", "2")],
    "telematics": [("255", "2")],
    "sound-image": [("253", "2")],
}
# A degree page can link a timetable that belongs to another programme; those titles are skipped.
SKIP_PLAN_TITLES = ("Doble Grado", "Programa Académico")

# Transversal skills / humanities courses shared by every degree. They stay in the catalog but are
# never used as automatic filler by the optimiser.
SKILLS_PATTERNS = (
    r"skills",
    r"competenc",
    r"language strateg",
    r"spreadsheet",
    r"writing",
    r"humanit",
    r"habilidades",
    r"hojas de c[aá]lculo",
    r"t[eé]cnicas de expresi[oó]n",
)

# Courses past exchange students recommended (matched on the normalised Spanish name).
STARTER_PICKS = (
    "aplicaciones moviles",
    "inteligencia artificial",
    "ingenieria del software de productos de inteligencia artificial",
    "fundamentos de gestion empresarial",
)

# --- semester calendar (official 2026/27 academic calendar) -----------------------------------------
EPOCH = dt.date(2027, 1, 1)  # session dates are stored as day numbers from this date
CALENDAR = {
    "first_monday": (dt.date(2027, 1, 25) - EPOCH).days,  # Monday of teaching week 1
    "break_week": 9,  # calendar week of Mar 22-28 (Easter, no classes)
    "calendar_weeks": 15,  # through the week of May 3-7
    "teaching_weeks": 14,
    "classes": "Jan 26 – May 7",
    "break": "Mar 22 – 29",
    "exams": "May 11 – 28",
    "resits": "Jun 14 – 30",
}
