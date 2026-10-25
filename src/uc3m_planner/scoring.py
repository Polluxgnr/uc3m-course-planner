"""Heuristic course scores from syllabus text and timetable.

maths  1-5  how much mathematical machinery a course leans on (prerequisites, contents, department)
hands  1-5  continuous-assessment share, lab share of contact hours, project/lab/programming vocabulary
ai     1-5  overlap with AI, data, software and app-development topics

Raw values are rank-mapped across the catalog, so 3.0 means "middle of the pack". The term lists
are bilingual because some syllabi only exist in Spanish.
"""

from __future__ import annotations

import bisect
import math
import re

MATH_TERMS = {
    r"differential equation|ecuaci[oó]n(es)? diferencial": 3,
    r"\bintegral|integrales|integration": 2,
    r"\bderivative|derivada|calculus|c[aá]lculo": 2,
    r"\btheorem|teorema|\bproof|demostraci": 3,
    r"eigen|autovalor|valores propios": 3,
    r"\bmatri(x|ces|z|ces)": 1,
    r"linear algebra|[aá]lgebra lineal": 2,
    r"fourier|laplace|z-transform|transformada": 3,
    r"stochastic|estoc[aá]stic|markov": 2,
    r"probabilit|random variable|variable aleatoria": 1,
    r"statistic|estad[ií]stic": 1,
    r"numerical method|m[eé]todos? num[eé]ric": 2,
    r"vector calculus|c[aá]lculo vectorial|gradient|divergence": 2,
    r"\btopolog|manifold|variedad": 3,
    r"\bseries\b|convergence|convergencia": 2,
    r"optimi[sz]ation|optimizaci": 1,
    r"partial differential|derivadas parciales|\bpde\b": 3,
    r"thermodynamic|termodin[aá]mic|fluid|fluido": 2,
    r"electromagnet|maxwell|quantum|cu[aá]ntic": 2,
    r"mechanics|mec[aá]nica": 1,
    r"signals?|se[ñn]al": 1,
    r"equation|ecuaci[oó]n": 1,
    r"mathemat|matem[aá]tic": 1,
}
HANDS_TERMS = {
    r"\blab|laborator": 2,
    r"\bproject|proyecto": 2,
    r"team|equipo|group work|trabajo en grupo": 1,
    r"programm|programaci|coding|code\b|c[oó]digo": 1,
    r"develop|desarroll": 1,
    r"prototyp|prototipo": 2,
    r"implement": 1,
    r"case stud|caso pr[aá]ctico|casos pr[aá]cticos": 1,
    r"presentation|presentaci": 1,
    r"python|java\b|kotlin|android|matlab|c\+\+|javascript|sql": 2,
    r"hands-on|practical|pr[aá]ctic": 1,
}
AI_TERMS = {
    r"artificial intelligence|inteligencia artificial|\bai\b|\bia\b": 3,
    r"machine learning|aprendizaje autom": 3,
    r"deep learning|neural|neuronal": 3,
    r"computer vision|visi[oó]n artificial|natural language|lenguaje natural": 3,
    r"\bdata\b|datos": 1,
    r"software": 2,
    r"programm|programaci": 1,
    r"mobile app|aplicaciones m[oó]viles|android|\bapp": 2,
    r"\bweb\b|cloud|nube|devops|api\b": 2,
    r"python": 2,
    r"agent|agente|search algorithm|b[uú]squeda heur": 2,
    r"database|base de datos": 1,
    r"product|producto|startup|business|empresa|management|gesti[oó]n": 1,
    r"algorithm|algoritm": 1,
    r"robot": 1,
}
MATH_DEPTS = {
    "Mathematics Department": 3,
    "Departamento de Matemáticas": 3,
    "Physics Department": 2,
    "Departamento de Física": 2,
    "Statistics Department": 1.5,
    "Departamento de Estadística": 1.5,
}
MATH_PREREQS = r"calcul|c[aá]lculo|algebra|[aá]lgebra|differential|diferencial|physics|f[ií]sica|statistic|estad[ií]stic"


def count(text: str, terms: dict[str, float]) -> float:
    """Weighted keyword hits, each term capped at 6 so one repetitive syllabus can't dominate."""
    low = text.lower()
    return sum(w * min(len(re.findall(p, low)), 6) for p, w in terms.items())


def _density(text: str, terms: dict[str, float]) -> float:
    return count(text, terms) / math.sqrt(max(len(text), 400))


def raw_scores(syl: dict, lab_share: float) -> tuple[float, float, float]:
    """Unscaled (maths, hands-on, AI) values for one course."""
    req, obj, cont = syl.get("req", ""), syl.get("obj", ""), syl.get("cont", "")
    body = "\n".join((req, obj, cont))
    maths = _density(body, MATH_TERMS) * 10
    maths += 2 * len(re.findall(MATH_PREREQS, req, re.I))
    maths += 2 * MATH_DEPTS.get(syl.get("dept", ""), 0)

    cont_pct = syl.get("cont_pct")
    hands = (cont_pct if cont_pct is not None else 40) / 100 * 5 + lab_share * 5
    hands += _density("\n".join((obj, syl.get("meth", ""), syl.get("assess", ""))), HANDS_TERMS) * 6

    ai = _density("\n".join((obj, cont)), AI_TERMS) * 10
    return maths, hands, ai


def rank_scale(values: list[float]) -> list[float]:
    """Map values to 1.0-5.0 by mid-rank; ties share a score."""
    order = sorted(values)
    top = max(len(order) - 1, 1)

    def scale(v: float) -> float:
        mid = (bisect.bisect_left(order, v) + bisect.bisect_right(order, v) - 1) / 2
        return round(min(5.0, 1 + 4 * mid / top), 1)

    return [scale(v) for v in values]


def deadlines(assess: str) -> list[int]:
    """Teaching weeks named as milestones in the assessment text ("week 8", "semana 14")."""
    found = re.findall(r"(?:week|semana)s?\s*(\d{1,2})", assess, re.I)
    return sorted({int(w) for w in found if 1 <= int(w) <= 16})
