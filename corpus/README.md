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

`truth.mjs` is that independent judgment, without polyman: it compiles the generators,
validator, checker and solutions with g++ and javac itself, generates the tests from the
script, runs each solution with the time limit and asks the checker about every test that
ran. `corpus:truth` runs it on every problem and fails if a pinned file disagrees, so the
expected verdicts are re-derived on each pipeline instead of trusted.

```bash
node corpus/truth.mjs pair-target          # print what expected/pair-target.json should say
node corpus/truth.mjs --check              # every problem against its pinned file
```

It reproduces `sum-parity.json`, which was pinned by hand before it existed. On Windows,
testlib validators expect CR LF line ends, so the validator steps come out false there.

## What is compared

- every verify step's pass/fail;
- every solution's per-test verdict and whether it matches its tag.

Timing is not judged exactly: an expected `OK` that comes back `TLE` is a warning (a slow
runner), and so are the tests after it, which polyman doesn't run once a solution times out.
A solution that never terminates must keep getting `TLE`.

## Needs

`g++`, `java` and Python 3 (polyman runs `python3`, or `python` if that is Python 3).
`run.mjs` prints the toolchain it saw so a report always says where it ran.

## Problems

`sum-parity` is polyman's own template; the other four were written for this corpus, statements
included (MIT, like the rest of the repository). Each has a main solution, correct ones in other
languages, and mutants whose true verdict is the point of the problem.

| Problem | What it pins | Solutions |
|---|---|---|
| `sum-parity` | polyman's own template plus WA/RE/PE/TL mutants in C++ and Python | 10 |
| `pair-target` | a special checker: any pair of positions with the right sum is accepted, so correct solutions that find other pairs (or print them in the other order) must be OK; using one position twice is WA, a missing number PE | 8 (C++, Java, Python) |
| `distinct-count` | several test cases per input file, standard checker `ncmp`: state not reset between cases (WA), only the first case answered (WA), `Case #k:` labels (PE), `vector::at` past the end (RE) | 7 |
| `mean-deviation` | real-valued output, standard checker `rcmp6` (1e-6): float arithmetic, two decimals, dividing by n - 1 (WA); "mean,deviation" as one token (PE) | 8 |
| `remainder-pairs` | a 2 s time limit that Java and Python must respect: linear solutions in all three languages pass, quadratic ones in Java and Python must get TLE on the first large test; an `int` answer that overflows (WA) | 7 |

On polyman 3.0.0 the corpus is red on every problem for the same two open bugs and nothing
else: the tests after a solution's first wrong answer are reported `OK` although the checker
never judged them (#21), and a presentation error is reported as `WA` (#28). Every `OK`, `TLE`
and `RTE`, and every solution's match with its tag, is right, Java and Python time limits included.

The verify service's sample problems (`service/samples/`, !8) are the other half: its golden set checks each solution against its tag through the service, including `wrong-tag` (a wrong solution tagged OK, which `verify` must reject). The corpus judges the CLI, test by test.

## Polygon round trip

`polygon-roundtrip.mjs` pushes a corpus problem to Polygon with `polyman remote push`, reads it
back through the Polygon API and compares it with the folder: solutions (tag, source type),
checker and validator tests, generator script lines, manual tests and statements. It also fails
when polyman reported a successful push although Polygon differs.

It generates the tests locally with polyman and compares every input with the one Polygon generated,
byte for byte apart from line endings (testlib's random generator is seeded from the arguments, so
the two match across platforms; on 3.0.0 all four tests of `sum-parity` do). It also expands every script in `scripts/` twice, with polyman's own parser and with Polygon
(saved as the testset's script, read back test by test), and puts the problem's script back after.
polyman generates tests locally from its expansion and Polygon from its own, so a difference means
the setter verified other tests than the ones Polygon publishes.

```bash
POLYGON_API_KEY=... POLYGON_API_SECRET=... node corpus/polygon-roundtrip.mjs --problem-id 605330
POLYGON_API_KEY=... POLYGON_API_SECRET=... node corpus/polygon-roundtrip.mjs --all
```

In CI it runs as `corpus:polygon` on the default branch only, where `POLYGON_API_KEY` and
`POLYGON_API_SECRET` are masked, protected variables of a test Polygon account. It runs with
`--all`: every problem listed in `polygon.json` with its Polygon problem, one JUnit report each.
Each problem needs a Polygon problem of its own, and creating one is a person's decision, so a
problem that isn't listed is reported as skipped (by name, in the log and as skipped test cases)
instead of silently left out. Today only `sum-parity` (605330) is listed.

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
