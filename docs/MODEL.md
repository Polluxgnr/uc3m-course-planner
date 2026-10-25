# The model and the optimiser

## Course scores (built offline, `scoring.py`)

Each course gets three heuristic scores, rank-scaled to 1.0–5.0 across the catalog (3.0 = median):

| Score | Built from |
| --- | --- |
| **maths** (`m`) | Density of maths and physics vocabulary in prerequisites, objectives and contents (English and Spanish); maths, physics or statistics prerequisites; the teaching department (Mathematics > Physics > Statistics) |
| **hands-on** (`h`) | Continuous-assessment share; lab share of contact time (from the timetable); project, lab, programming and tooling vocabulary in objectives, methodology and assessment |
| **AI & software** (`a`) | Density of AI, ML, data, software, app, web and tooling vocabulary in objectives and contents |

Term counts are capped per term and divided by √(text length), so long syllabi don't win by being long.

The engine also derives:

- **difficulty**: 0.75 × maths + 0.25 × course year rescaled to 1–5.
- **hours**: the average weekly contact hours of the course's lightest group.

## Plan score (`engine.js`)

A plan is a set of (course, group) pairs. Its score is

```
score = 100 × Σ wᵢ · vᵢ / Σ wᵢ  −  1.5 × max(0, ECTS − target)
```

with weights wᵢ ∈ {0…5} from the sliders, and each criterion value vᵢ ∈ [0, 1]:

| Criterion | vᵢ |
| --- | --- |
| AI & software | ECTS-weighted mean of (a − 1) / 4 |
| Hands-on | ECTS-weighted mean of (h − 1) / 4 |
| Maths load | ECTS-weighted mean of (5 − difficulty) / 4 |
| Continuous assessment | ECTS-weighted mean of 1 − exam% / 70 (missing → 50 %) |
| Compact week | free weekdays averaged over the 14 teaching weeks, / 3 |
| Contact hours | (24 − weekly hours) / 14 |
| No dead time | 1 − idle hours per week / 6 |
| Fewer courses | (8 − number of courses) / 3 |
| Your picks | Want courses included / Want courses available |

All values are clamped to [0, 1].

- **Week-by-week metrics.** Compact week, hours and dead time are computed per calendar week, so a lab
  that meets on three Thursdays costs three Thursdays, not fourteen.
- **Dead time** is any empty stretch between two classes on the same day, minus the standard 15-minute
  changeover between slots.

**Hard constraints:**

- ECTS between the target and the maximum.
- Every Must course included.
- Each group inside the hours window, off your free days, and in the chosen language.
- No two groups overlapping on any date.
- At most one variant of the same course.

## Search

Depth-first branch and bound over the candidates (your shortlist plus, optionally, the 18 best-matching
other courses; skills courses are never auto-added). Must and Want courses come first, then candidates in
order of match. Each course branches on its allowed groups, and on "skip" unless it's a Must.

**State.** Every group is pre-encoded as a list of (week × weekday) slots, each holding a 64-bit mask of
15-minute bins from 07:00 (two `Uint32`s):

- **Clash test:** AND of the masks.
- **Add / remove a group:** OR / AND-NOT.
- **Idle time of a slot:** computed in O(1) from the mask: `(span − ones) − (runs − 1)` bins, using
  popcount and the lowest and highest set bits.

Free weekdays, hours, criterion sums and the Want count are updated incrementally, so scoring a complete
plan doesn't rebuild anything. A test checks that this incremental score equals the reference `metrics()`
implementation.

**Bound.** For a partial plan, every criterion is replaced by an optimistic value:

| Criterion | Optimistic value |
| --- | --- |
| Free weekdays | Current value: adding a course never frees a day |
| Contact hours | Current hours + remaining ECTS × the lowest hours-per-ECTS still available |
| Course-level criteria | Remaining ECTS filled at the best value still available |
| Dead time | Perfect |
| Number of courses | Fewest courses that could still reach the target |
| Your picks | Every remaining Want included |

A branch is cut only when this bound can't beat the current third-best complete plan, so the top three
are exact whenever the search finishes (`stats.complete`). Typical searches over 20+ candidates finish in
1–5 s at about 150k partial plans per second. The time budget is 6 s; if it runs out, the page says the
plans are the best found so far.

## Fallbacks and robustness

For each course in a plan, the engine evaluates:

- every other group of that course, and
- every shortlisted course plus the 30 best-matching others, each in its best group,

against the rest of the plan. It ranks these replacements by the **whole plan's score after the swap**,
and flags replacements that leave the plan short of the ECTS target.

A course is **covered** when its best replacement keeps the plan complete and within 8 points of the
original score. The plan header shows coverage as "4/5 courses with a good fallback".

## Known limitations

- **Keyword scores** can be fooled by unusual wording. The rank scaling limits the damage but doesn't
  remove it.
- **Teaching language** is inferred per group from the degree variants the group serves.
- **Exam dates** aren't modelled; only the share of the grade that comes from the final exam is.
