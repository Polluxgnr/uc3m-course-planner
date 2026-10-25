"""Dataset building and scoring helpers."""

import pytest

from uc3m_planner import config
from uc3m_planner.dataset import build, date_ranges, day_number, is_skills_course, norm
from uc3m_planner.scoring import deadlines, rank_scale, raw_scores


def test_day_numbers_and_ranges():
    assert day_number("01.ene") == 0
    assert day_number("01.feb") == 31
    assert date_ranges(["01.feb-15.mar", "07.may"]) == [[31, 73], [126, 126]]
    whole = date_ranges(["garbage"])
    assert whole[0][0] == config.CALENDAR["first_monday"]


def test_norm_merges_spelling_variants():
    assert norm("Fundamentos de Gestión Empresarial (UC3M)") == norm("fundamentos de gestion empresarial")


@pytest.mark.parametrize(
    "name, es, ects, expected",
    [
        ("Information Skills", "Habilidades", 1.5, True),
        ("Writing and communication skills", "Técnicas de expresión oral y escrita", 3, True),
        ("Advanced knowledge of Spreadsheets", "Hojas de cálculo. Nivel avanzado", 1.5, True),
        ("Mobile Applications", "Aplicaciones Móviles", 6, False),
        ("Environmental Technology", "Tecnología Ambiental", 3, False),
    ],
)
def test_skills_courses(name, es, ects, expected):
    assert is_skills_course(name, es, ects) is expected


def test_rank_scale_spreads_and_ties():
    assert rank_scale([10, 20, 30]) == [1.0, 3.0, 5.0]
    tied = rank_scale([1, 1, 5])
    assert tied[0] == tied[1] < tied[2] == 5.0


def test_deadlines_teaching_weeks():
    assert deadlines("Milestone 1 (week 3). Milestone 2 (week 8). Final (week 14 or 15). Semana 30") == [3, 8, 14]


def test_maths_heavy_syllabus_scores_higher():
    maths = {
        "req": "Calculus\nLinear Algebra",
        "cont": "Differential equations, Fourier and Laplace transforms, theorem proofs",
        "dept": "Mathematics Department",
        "cont_pct": 40,
    }
    apps = {"req": "Programming", "cont": "Android apps, REST APIs, team project in the lab", "cont_pct": 100}
    m1, h1, _ = raw_scores(maths, lab_share=0.0)
    m2, h2, a2 = raw_scores(apps, lab_share=0.3)
    assert m1 > m2 and h2 > h1 and a2 > 0


def _subject(code, degree, lang, group="1", day="Mon", campus=config.CAMPUS, name_es="Aplicaciones Móviles", ects=6.0):
    return {
        "code": code,
        "name": "Mobile Applications",
        "name_es": name_es,
        "ects": ects,
        "lang": lang,
        "block": "Curso 3º",
        "degree": degree,
        "campus": campus,
        "elective": False,
        "syllabus": f"https://x/{code}",
        "in_plan": True,
        "sessions": [{"day": day, "start": "09:00", "end": "10:30", "kind": "TEORÍA", "group": group, "dates": ["01.feb-15.mar"], "rooms": ["A"]}],
    }


def test_build_merges_variants_keeps_group_languages_and_filters_campus():
    timetables = {
        "scraped": "2026-10-25",
        "degrees": {"data-science": {"name": "DS"}, "sound-image": {"name": "SI"}},
        "subjects": [
            _subject("16504", "data-science", ["English"], group="96"),
            _subject("13345", "sound-image", ["Spanish"], group="66", day="Tue"),
            _subject("1", "data-science", ["English"], campus="Colmenarejo", name_es="Otra"),
        ],
    }
    syllabi = {"https://x/16504": {"exam_pct": 30, "cont_pct": 70, "assess": "week 8", "lang_page": "en"}}
    data = build(timetables, syllabi)
    assert len(data["courses"]) == 1
    course = data["courses"][0]
    assert course["codes"] == ["13345", "16504"]
    assert course["ex"] == 30 and course["wk"] == [8]
    assert {g["g"]: g["l"] for g in course["groups"]} == {"66": ["Spanish"], "96": ["English"]}
    assert course["rec"] is True
    assert data["calendar"] == config.CALENDAR
