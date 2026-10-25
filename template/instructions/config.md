# config.md — `Config.json` schema

The single source of truth for the whole problem. Every other file is referenced from here.

## Top-level fields

```jsonc
{
  "problemId": 12345,                    // optional; set after `polyman remote push`
  "name": "my-problem",                  // lowercase, dashes only
  "owner": "username",                   // optional Polygon owner
  "description": "Short description.",
  "tags": ["implementation", "math"],

  "timeLimit": 1000,                     // ms, applied to every solution (scaled per language locally by timeLimitMultipliers)
  "timeLimitMultipliers": { "java": 2 }, // optional; local-only scaling of timeLimit per language (cpp/java/python), Polygon keeps timeLimit
  "memoryLimit": 256,                    // MB
  "inputFile": "stdin",                  // keep "stdin" unless asked
  "outputFile": "stdout",                // keep "stdout" unless asked
  "interactive": false,                  // see instructions/checker.md (custom checker) — true is rare
  "cppStandard": "c++23",                // optional; local g++ -std= value for every C++ file (unset: solutions use their sourceType standard, the rest c++23)

  "compiler": {                          // optional, local-only; omit unless the user asks
    "cpp": "g++-15",                     // C++ compiler executable or path (default "g++"); POLYMAN_CXX overrides it
    "javac": "javac",                    // Java compiler executable or path (default "javac"); POLYMAN_JAVAC overrides it
    "flags": ["-Wall"]                   // extra C++ flags, one per item; a -std= here replaces cppStandard, an -O replaces -O2
  },

  "statements":  { …see statements.md… },
  "solutions":   [ …see solutions.md…  ],
  "generators":  [ …see generators.md… ],
  "validator":   { …see validator.md…  },
  "checker":     { …see checker.md…    },
  "testsets":    [ …below             ]
}
```

`cppStandard` and `compiler` only change how polyman compiles on this machine. They are never sent to Polygon (Polygon uses each file's `sourceType`). Every C++ compile runs `<compiler> -O2 -std=<standard> <flags...>`, where an `-O` item in `flags` replaces `-O2`. C++ solutions also get `-DONLINE_JUDGE` right after the standard, like on Codeforces, unless `flags` already defines `ONLINE_JUDGE`. Generators, the validator and the checker do not get it.

The `-std=` value comes from the first of these that is set:

1. a `-std=` item in `flags`,
2. `cppStandard`,
3. for solutions only, the standard in the solution's `sourceType` (`cpp.g++17` gives `c++17`, `cpp.gcc14-64-msys2-g++23` gives `c++23`; `cpp.ms2017` and `cpp.ms2019` name none),
4. the default `c++23`.

Java programs still run with `java` from `PATH`. A malformed `compiler` block (unknown key, blank string, `flags` not an array of strings) stops the compile with an error.

## Schema

`Config.schema.json` (next to `Config.json`) is a JSON Schema (draft-07) for this file. `Config.json` points at it via its first key, `"$schema": "./Config.schema.json"`, so editors validate as you type and every enum (solution tags, `sourceType` values, points/feedback policies) and every required key is machine-checkable. polyman itself ignores `$schema`; it is never pushed to Polygon. Keep the key. If you need to validate by hand:

```bash
npx --yes ajv-cli validate -s Config.schema.json -d Config.json
```

The schema mirrors the `ConfigFile` type in polyman's `src/types.d.ts`; if the two disagree, the type wins and the schema is the bug.

## `testsets[]`

Usually one named `"tests"`. Each entry:

```jsonc
{
  "name": "tests",
  "groupsEnabled": true,                 // optional, default false
  "pointsEnabled": false,                // optional, default false
  "groups": [                            // required if groupsEnabled
    { "name": "samples" },
    { "name": "main" }
  ],
  "generatorScript": {                   // see instructions/generator-script.md
    "scriptFile": "./generators/gen-script.txt"
    // OR: "script": "<#-- @group main -->\ngen 1 > $\n"
  },
  "manualTests": [                       // see instructions/manual-tests.md
    { "input": "./manual/tests/m-01-sample.in",
      "output": "./manual/tests/m-01-sample.out",
      "index": 1, "group": "samples", "useInStatements": true }
  ]
}
```

- `generatorScript` and `manualTests` are independent: tests come from both, indexed in one shared 1..N space.
- Indices in the script (`> N` / `> {…}`) and in `manualTests[].index` must be globally unique inside a testset.

## Common edits

- **Add a solution / generator / manual test** → add the source file *and* the `Config.json` entry in the same edit.
- **Change time/memory** → update `timeLimit` / `memoryLimit`, run `polyman verify`.
- **Use another local compiler** (e.g. `g++-15`, `clang++`) → set `compiler.cpp`, or run with `POLYMAN_CXX=<compiler>` for one run; leave `sourceType` alone, it is what Polygon uses.
- **A Java or Python solution TLEs locally but is correct** → add `timeLimitMultipliers` (`{ "java": 2 }`) instead of inflating `timeLimit` for every solution; the factor only applies to local runs, so Polygon keeps the real limit.
- **Switch checker** → see `instructions/checker.md`.
- **Multiple testsets** → append another `testsets[]` entry; each testset has its own script + manuals.

## What NOT to do

- Don't desync `Config.json` from disk: every solution / generator / manual file referenced here must exist (and vice-versa for declared entries).
- Don't add `commands[]` under `generatorScript` — that shape was removed. Use `script` or `scriptFile` only.
- Don't reference an undefined group from a script `@group` header or a manual entry.
- Don't change `name` after the first `polyman remote push` — Polygon problem names are immutable post-creation.

## After any `Config.json` change

Run `polyman verify`. A failed `verify` blocks everything.
