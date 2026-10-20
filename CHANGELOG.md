# Changelog

## 3.0.2

- polyman retries a Polygon call once after a network error, an HTTP 5xx or an HTML page, for reads and for uploads that replace an item; calls that could create a duplicate are never retried. A 5xx that carries Polygon's JSON `FAILED` answer is reported as that error, not retried (#86).
- `remote package` sends the `full` and `verify` flags the right way round: `full`, `linux` and `windows` build a full package, and every build is verified (#27).
- `remote push` keeps every path from `Config.json` inside the problem folder, including a generator's `scriptFile`, and checks manual tests and checker/validator test files before it clears or uploads anything (#62).
- Checker self-tests that expect `WRONG_ANSWER` or `PRESENTATION_ERROR` are judged by that expectation (#58).
- `new`, `download-testlib` and `list` take `--json` (#71).
- `remote push` exits with code 2 instead of waiting for a prompt when stdin is not a terminal; pass `--yes` and `--name` to run it from a script (#73).
- Colors are off when `NO_COLOR` is set, when stdout is not a terminal, or when `POLYMAN_AGENT=1` (#73).
- Generator, validator and checker failures end with an error and an exit code instead of `process.exit` (#67).
- The Node version check accepts a `v`-prefixed version and Node majors above 22.
- `run`, `test` and `verify` can scale the time limit per language with the optional `timeLimitMultipliers` in `Config.json`, for example `{ "java": 2, "python": 3 }`. Local runs only, Polygon still gets the plain `timeLimit`. A bad value stops before anything runs. From GitHub PR 98 by ElectLive (#5, #11).
