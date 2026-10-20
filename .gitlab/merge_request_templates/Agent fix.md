<!--
A fix an agent built on a person's go-ahead (issue-builder, pipeline-fixer,
or the reviewer's fix rounds). The flows write their own descriptions in
this shape (e.g. !26, !73); a person can pick this template to write or
complete one. The rules below are the ones `autonomy:goahead` and the wiki
page Assisted already have, nothing more.
-->

Closes #

## What changed

<!-- Files and functions, and what each change does. Say what was left alone on purpose. -->

## Test

<!--
The test that fails without the change and passes with it: file, case, and
what it expects. A fix without one accepts the same bug back (CLAUDE.md).
-->

## Judges on this head

<!-- Link the jobs from this MR's pipeline. Quote the numbers as the jobs print them. -->

- Unit tests (Node 20 and 22):
- `corpus`:
- The judge that found the bug, if it's another one (toolchain lane, `corpus:polygon`, `corpus:mutation`):

## Not covered

<!-- What this MR doesn't fix or couldn't run, and who needs to check it. -->

## Go-ahead

Go-ahead: <!-- link to the note: `@<agent> go-ahead` on one line, after the agent's latest proposal -->

<!--
What `autonomy:goahead` checks, from GitLab's notes and push events (never
from the commit's "Go-ahead:" trailer, which the agent writes):
- each agent push comes after a go-ahead that is newer than the agent's
  latest proposal and its previous push; one go-ahead, one push; editing the
  proposal afterwards cancels it;
- the go-ahead is from someone in go_ahead.people in .autonomy.yml, and not
  the requester: this MR's author or the author of the issue it closes;
- at high risk (the tier `autonomy:assess` puts in the pipeline name) and for
  rollbacks, only from go_ahead.maintainers;
- agents never change governance paths (`autonomy:guard`).
-->

## Before a person merges

- [ ] `autonomy:goahead` and `autonomy:guard` passed on this head
- [ ] mr-reviewer's latest "Review of" note is for this head and has no P1 or P2 left
- [ ] Checks run locally or in CI: lint, format:check, vitest, build
