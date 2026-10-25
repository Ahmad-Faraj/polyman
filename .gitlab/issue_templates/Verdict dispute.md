<!--
Use this when you think polyman judged a solution wrongly: a wrong answer
reported as OK, a correct solution reported as a failure, a checker or
validator test that passes when it shouldn't, or a verdict that differs from
the problem platform's.

This project is public. Attach only a problem you own or one you made up for
this report, never someone else's problem, and no API keys
(~/.polyman/credentials.json) or other secrets.
-->

## Problem

<!--
The smallest problem package that shows it: attach a zip, or paste the
solution, the test and the checker (or say it's a standard one, e.g. wcmp).
A made-up problem with one test is ideal.
-->

## Where it ran

- polyman version (`polyman --version`):
- Installed from (npm, a canary, a clone of `main` at commit ...), or the verify service:
- OS:
- Compiler or interpreter (`g++ --version`, `java -version`, `python3 --version`):

## Command

```sh
# the exact command, e.g. polyman verify --json, or polyman run <solution> --all
```

## Verdicts

| Solution and its tag | Test | polyman said | Expected | The platform said (if you have it) |
|---|---|---|---|---|
|  |  |  |  |  |

<!-- Paste polyman's output, or the part of `--json` that shows the verdict, in a code block. -->

## Why the expected verdict is right

<!--
What the solution prints on that test and why the checker should accept or
reject it. If you're not sure, say so: an honest "not sure" is useful.
-->

<!--
What happens next: someone on the team checks it. If it reproduces, they
open a Judge finding that links this issue, and that is what the agents
build from (issue-builder only builds from an issue someone on the team
wrote).
-->

/label ~bug
