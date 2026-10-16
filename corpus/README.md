# polyman corpus

Real problems and deliberately wrong solutions whose **true** verdicts are pinned in
`expected/`. `run.mjs` runs `polyman verify --json` on a fresh copy of every problem and
fails if polyman judges any solution differently. The unit tests mostly mock processes and
never run `verify` on a real problem; this runs real compilers, real checkers and real solutions.

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

The verify service's sample problems (`service/samples/`, !8) are the other half: its golden set checks each solution against its tag through the service, including `wrong-tag` (a wrong solution tagged OK, which `verify` must reject). The corpus judges the CLI, test by test.

## Polygon round trip

`polygon-roundtrip.mjs` pushes a corpus problem to Polygon with `polyman remote push`, reads it
back through the Polygon API and compares it with the folder: solutions (tag, source type),
checker and validator tests, generator script lines, manual tests and statements. It also fails
when polyman reported a successful push although Polygon differs.

It also expands every script in `scripts/` twice, with polyman's own parser and with Polygon
(saved as the testset's script, read back test by test), and puts the problem's script back after.
polyman generates tests locally from its expansion and Polygon from its own, so a difference means
the setter verified other tests than the ones Polygon publishes.

```bash
POLYGON_API_KEY=... POLYGON_API_SECRET=... node corpus/polygon-roundtrip.mjs --problem-id 605330
```

In CI it runs as `corpus:polygon` on the default branch only, where `POLYGON_API_KEY` and
`POLYGON_API_SECRET` are masked, protected variables of a test Polygon account.

## Mutation testing

`corpus:mutation` runs [Stryker](https://stryker-mutator.io/) on `src/helpers/solution.ts`, where
verdicts are decided: it makes hundreds of small changes ("mutants") to the code and counts how many
the unit tests catch. On 3.0.0: 463 mutants, 115 survive and 34 are never executed by any test, a
score of 67.8%. One survivor: `isWATag` returning `true` for every tag passes all 967 tests. With
that bug, a solution tagged OK that gives wrong answers would no longer fail `verify`.

```bash
npm i --no-save --legacy-peer-deps @stryker-mutator/core@9 @stryker-mutator/vitest-runner@9
TZ=Asia/Kolkata ./node_modules/.bin/stryker run corpus/stryker.config.json   # report: corpus/out/mutation/index.html
```

## Upstream drift

polyman depends on two things it doesn't control: Polygon's API (documented in
`codeforces/polygon-misc`) and `testlib.h`. `upstream.mjs` compares their latest commits with the
ones pinned in `upstream.json` and fails, listing what changed, when either moved (`corpus:upstream`,
nightly). After checking polyman against the change, `node corpus/upstream.mjs --update` moves the pins.
