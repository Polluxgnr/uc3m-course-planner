"""Parsers against minimal HTML shaped like the real UC3M pages."""

from uc3m_planner.http import decode
from uc3m_planner.parsers import campus_of, parse_degree_page, parse_plan_page, parse_subject_timetable, parse_syllabus

DEGREE_PAGE = """
<li id="program_currentprogram"><h3>Year 3 - Semester 2</h3>
<table><caption class="oculto">General subjects</caption>
<tr><td data-label="Subject"><a href="https://aplicaciones.uc3m.es/cpa/generaFicha?est=350&plan=392&asig=16504&idioma=2">
<span>Mobile Applications</span></a></td><td data-label="ECTS"><span>6</span></td><td data-label="TYPE"><span>C</span></td>
<td data-label="Language"><img alt="English" src="x.jpg"/></td></tr></table>
<table><caption>Electives to choose: total 24 ECTS credits</caption>
<tr><td data-label="Subject"><a href="/cpa/generaFicha?est=350&plan=392&asig=99999&idioma=2">Odd one</a></td>
<td data-label="ECTS">n/a</td></tr></table></li>
<a href="https://aplicaciones.uc3m.es/horarios-web/publicacion/plan.page?plan=566&amp;centro=2">Schedule</a>
<a href="https://aplicaciones.uc3m.es/horarios-web/publicacion/plan.page?plan=566&amp;centro=2">Schedule again</a>
"""


def test_degree_page():
    subjects, plans = parse_degree_page(DEGREE_PAGE)
    assert plans == [("566", "2")]
    mobile = subjects["16504"]
    assert mobile["name"] == "Mobile Applications"
    assert mobile["ects"] == 6.0
    assert mobile["lang"] == ["English"]
    assert mobile["where"] == "Year 3 - Semester 2"
    assert not mobile["elective"]
    assert subjects["99999"]["ects"] is None and subjects["99999"]["elective"]


PLAN_PAGE = """
<h1 id="nombreApp">Curso 2026/2027 - Horarios de Grado en Ciencia e Ingeniería de Datos (Leganés)</h1>
<h4 class="asignatura-curso-title">Curso 3º</h4>
<a class="asignatura-link" href="/horarios-web/publicacion/2026/porCentroPlanAsignatura.tt?plan=392&centro=2&asignatura=16504&tipoPer=C&valorPer=1">
<span><strong>16504</strong> - Aplicaciones Móviles</span></a>
"""


def test_plan_page():
    title, entries = parse_plan_page(PLAN_PAGE, semester=2)
    assert campus_of(title) == "Leganés"
    assert entries == [
        {
            "code": "16504",
            "name_es": "Aplicaciones Móviles",
            "block": "Curso 3º",
            "url": "https://aplicaciones.uc3m.es/horarios-web/publicacion/2026/porCentroPlanAsignatura.tt"
            "?plan=392&centro=2&asignatura=16504&tipoPer=C&valorPer=2",
        }
    ]


def _cell(kind, group, time, dates, rowspan=6):
    return (
        f'<td rowspan="{rowspan}" class="celdaConSesion"><div>{kind}</div>'
        f'<div class="asignaturaAgrupacion">16504-APLICACIONES, 3º,2ºC,grp.{group}</div>'
        f'<div>{time}</div><div class="fechasSesion"><span class="fechas">{dates}:</span><span class="aulas">Aula 4.0.E05</span></div></td>'
    )


TIMETABLE = f"""
<table class="timetable"><thead><tr><th class="esquinaVacia"></th><th>LUNES</th><th>MARTES</th>
<th colspan="2">MIERCOLES</th><th>JUEVES</th><th>VIERNES</th></tr></thead><tbody>
<tr><th>09:00</th>{_cell("TEORÍA", "66", "09:00 a 10:30", "01.feb-15.mar")}<td></td>
{_cell("TEORÍA", "66", "09:00 a 10:30", "27.ene-17.mar")}{_cell("PRÁCTICAS", "67", "09:00 a 10:30", "17.feb-24.feb")}
<td></td><td></td></tr>
<tr><th>09:15</th><td></td><td></td><td></td></tr>
</tbody></table>
"""


def test_subject_timetable_maps_colspans_and_rowspans_to_days():
    sessions = parse_subject_timetable(TIMETABLE)
    got = {(s["day"], s["group"], s["kind"]) for s in sessions}
    assert got == {("Mon", "66", "TEORÍA"), ("Wed", "66", "TEORÍA"), ("Wed", "67", "PRÁCTICAS")}
    assert all(s["start"] == "09:00" and s["end"] == "10:30" for s in sessions)
    assert sessions[0]["rooms"] == ["Aula 4.0.E05"]


def test_subject_timetable_without_grid():
    assert parse_subject_timetable("<p>Horarios no disponibles</p>") == []


SYLLABUS = """<div>Coordinating teacher:
GARCIA, BONI</div><div>Department assigned to the subject:
Telematic Engineering Department</div>
<div>Requirements (Subjects that are assumed to be known)
Programming</div>
<div>
Objectives
Design and program mobile apps.</div>
<div>Description of contents: programme
1. Introduction to Android</div>
<div>Assessment System
% end-of-term-examination/test\xa00
% of continuous assessment (assigments, laboratory, practicals...)\xa0100
Milestone 2 (week 8).</div>
<div>Basic Bibliography
Head First Android</div>"""


def test_syllabus_sections_and_split():
    out = parse_syllabus(SYLLABUS)
    assert out["req"] == "Programming"
    assert out["obj"] == "Design and program mobile apps."
    assert out["cont"].startswith("1. Introduction to Android")
    assert (out["exam_pct"], out["cont_pct"]) == (0, 100)
    assert "Head First" not in out["assess"]
    assert out["coord"] == "GARCIA, BONI"
    assert out["dept"] == "Telematic Engineering Department"
    assert out["lang_page"] == "en"


def test_decode_handles_mislabelled_pages():
    assert decode("Álgebra".encode()) == "Álgebra"
    assert decode("Álgebra".encode("cp1252")) == "Álgebra"
