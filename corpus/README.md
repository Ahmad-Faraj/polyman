# polyman corpus

Real problems and deliberately wrong solutions whose **true** verdicts are pinned in
`expected/`. `run.mjs` runs `polyman verify --json` on a fresh copy of every problem and
fails if polyman judges any solution differently. The unit tests mock processes; this
runs real compilers, real checkers and real solutions.

```bash
npm run build
node corpus/run.mjs                 # check against expected/, writes out/junit.xml + out/summary.json
node corpus/run.mjs --only sum-parity
node corpus/run.mjs --record        # draft expected/ from polyman's own output (review before committing!)
```

## How expected verdicts are set

`--record` only drafts a file. A recorded file trusts polyman, so it would freeze polyman's
bugs into the corpus. Every pinned verdict is checked against an independent judgment of the
solution's actual output before it is committed. Agents may not change anything in `corpus/`
(the `autonomy:guard` job), so an agent's change to polyman cannot also change what judges it.

## What is compared

- every verify step's pass/fail;
- every solution's per-test verdict and whether it matches its tag.

Timing is not judged exactly: an expected `OK` that comes back `TLE` is a warning (a slow
runner), but a solution that never terminates must keep getting `TLE`.

## Needs

`g++`, `java`, and Python reachable as `python` (polyman runs `python <file>`).
`run.mjs` prints the toolchain it saw so a report always says where it ran.

## Problems

| Problem | What it pins |
|---|---|
| `sum-parity` | polyman's own template plus WA/RE/PE/TL mutants in C++ and Python |
