<!--
For the team: a judge (corpus, toolchain lanes, Polygon round trip, mutation
testing, the nightly on the published package, an audit) found a bug.

Title: the symptom a user would see, e.g. "Python solutions are judged
Runtime Error on systems without a python command" (#22).

Labels: add one of each from the sidebar.
- found-by: corpus, polygon, mutation, audit, review (who found it)
- class: judge-lies (polyman reports a wrong verdict), environment-drift
  (correct problems fail on users' machines), platform-sync (what polyman
  sends isn't what Polygon gets)
- stage: where the bug shows, usually stage::verify

issue-builder builds only from an issue someone on the team wrote, and you,
the author, can't give it the go-ahead: someone else on the team does
(a maintainer for high risk). See the wiki page Assisted.
-->

## Problem

<!--
What polyman does, where in the code (file and function), and why it matters
to a user. Say what still works, if anything. E.g. #21: "The overall
pass/fail of a solution is still right."
-->

## How to see it

<!--
The job that found it, linked (e.g. corpus job 17261412692), the problem and
solution or lane (`sum-parity` / `wa_always_yes`, lane `no-python-alias`),
expected vs got, and the command to run it locally (`node corpus/run.mjs`).
If it isn't reproduced yet, say so in bold, as #89 does.
-->

- Job:
- Case:
- Expected:
- Got:

## Done when

- [ ] <!-- the behaviour, stated so a reviewer can check it -->
- [ ] A Vitest test covers it and fails without the fix
- [ ] The judge that found it passes (name the job or lane)
- [ ] `npm run build`, `npm run lint` and `npm test` pass

/label ~bug
