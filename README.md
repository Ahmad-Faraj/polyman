<div align="center">

<img src="logo.png" alt="Polyman Logo" width="200"/>

# Polyman

**CLI tool for Codeforces problem setters** to automate the complete workflow for creating, testing, and verifying competitive programming problems.

[![npm version](https://img.shields.io/npm/v/polyman.svg?style=flat-square)](https://www.npmjs.com/package/polyman-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-43853D?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Documentation](https://img.shields.io/badge/docs-TypeDoc-blue?style=flat-square)](https://hamzahassanain.github.io/polyman/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](http://makeapullrequest.com)

---

**Quick Links** | [Why?](#why-polyman) • [Installation](#installation) • [Quick Start](#quick-start) • [Commands](#commands) • [Tags](#solution-tags) • [Checkers](#standard-checkers) • [Structure](#project-structure) • [Config](#configuration) • [Docs](#documentation) • [Workflow](#workflow-summary) • [Issues](#common-issues) • [Support](#support) • [Contributing](#contributing) • [License](#license)

</div>

## GitLab Transcend: Life After Code (Path B · Assisted)

**Who judges the judge?** polyman tells problem setters whether every solution gets the right verdict, and its unit tests are all green. So on GitLab we check it with judges that are neither an LLM nor us, and Duo agents fix what those judges find, one step at a time, each step on a go-ahead from a person who didn't ask for the work.

<!-- Video (under 3 minutes): put its link here, first in this list, once it is published. -->

- **Live service:** [polyman-verify on Cloud Run](https://polyman-verify-ncvkutguda-ue.a.run.app) (`/health` answers `{"ok":true}`)
- **Release:** [`polyman-cli` on npm](https://www.npmjs.com/package/polyman-cli), 3.0.0 today. The next version ships only through the judged release jobs ([!47][mr47]): npm `next`, judged against `latest`, then `latest`.
  <!-- Once 3.0.1 is out: name it here, link its GitLab Release and the next-check job. -->
- **Original repository:** [HamzaHassanain/polyman](https://github.com/HamzaHassanain/polyman), imported at [`dcb5779`](https://github.com/HamzaHassanain/polyman/commit/dcb5779705da91bc898cc456a0d96bd5d311cf41) ("release: 3.0.0", 2026-09-25), tagged `hackathon-start` here.

### Check it yourself: no login, 60 seconds

1. **[!5][mr57]: https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/57
[mr5]: one wrong line, all unit tests green, the judge says no.** The demo makes the wrong-answer rule also accept `OK`. In [this pipeline](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/pipelines/2959006759) all 974 unit tests pass on Node 20 and 22, and the verify service's golden set [fails on the `wrong-tag` sample, and only there](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/jobs/17258296779).
2. **[#45][i45]: the nightly judges caught the published `polyman-cli@3.0.0` misjudging.** No one asked for it: incident-responder runs when a pipeline on `main` fails, and it opened #45 a minute after the [scheduled run](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/pipelines/2959571332) went red.
3. **[#22][i22] → [!26][mr26]: one full Assisted loop.** issue-builder's [proposal](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/issues/22#note_4035973201), [Mazen's go-ahead](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/issues/22#note_4036138042) (Ahmed filed #22), the MR, the [guard accepting it](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/jobs/17259651990), the [review](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/26#note_4036237877), and a person's merge.

### October 18, 03:09 UTC: the judges catch the release people install

Every night a [schedule](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/pipeline_schedules) runs the corpus and the Polygon round trip against `polyman-cli@latest` from npm. On October 18 [`corpus:production`](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/jobs/17261412692) failed: 3.0.0 judged deliberately wrong solutions `OK` on tests the checker never judged, and reported a presentation error as `WA`. incident-responder opened [#45][i45] at 03:20 and mapped each failure to the bug behind it ([#21][i21], [#28][i28]). It also noticed that #21 was closed while `main` still failed.

A person checked each point the same morning. #21 had been closed by mistake (by the MR that added the corpus that detects it), so it was reopened. The round-trip error got an HTTP-status log ([!48][mr48]), and the next run showed the cause: Polygon answering HTTP 502 and 524, errors on its side ([note](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/issues/45#note_4036911018)). issue-builder's proposals for [#21](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/issues/21#note_4036864596) and [#28](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/issues/28#note_4036156918) got their go-ahead from Hamza, who didn't file them (high risk: only a maintainer's go-ahead counts). issue-builder opened [!73](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/73) for #21; #28 is next.

### The judges, and who may say go-ahead

An agent proposes and waits. A person who didn't ask for the work replies `@<agent> go-ahead` (for high risk, governance paths and rollbacks only a maintainer, Hamza or Mazen, and never the one who asked), and the agent does that one step. The judges in the first three rows are programs, not an LLM. The CI job `autonomy:goahead` fails any agent push without a valid go-ahead. Full rules: [Assisted](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/wikis/Assisted).

| What is checked, and by what | Who may say go-ahead | A real run |
|---|---|---|
| Every per-test verdict: real g++, Java and Python run five original problems with deliberately wrong solutions (the corpus; `corpus:truth` works out the true verdicts without polyman) | nobody needs to: it reports, and a person files what it finds | [!4][mr4] (verdict matrix in the MR) |
| What Polygon stored after `polyman remote push`, read back and compared test by test | nobody needs to (runs on `main` and nightly) | [#25][i25], [#31][i31] |
| How many planted bugs the unit tests catch (mutation testing) | nobody needs to | [`corpus:mutation`](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/jobs/17262230236) |
| An agent's fix for a judge bug: the judges above, then a person | a teammate who didn't file the issue; a maintainer at high risk | [#22][i22] → [!26][mr26] |
| An agent's push to an MR | the same rule, checked by the guard | [refused](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/jobs/17258462748) on !17, [accepted](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/jobs/17259651990) on !26 |
| A package as installed (canary, then npm `next`), judged by the corpus before `latest` | a person clicks each publish job | [canary 3.0.0-canary.335](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/jobs/17262230241) → [judged](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/jobs/17262230242): red, on #21 and #28 |
| The live service: golden set on a candidate, then a production check | a person promotes; a failed check rolls back by itself; a rollback MR needs the maintainer | fire drill: [pipeline](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/pipelines/2959322051) → [rollback](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/jobs/17260123329) → [incident #44][i44] |

### What people did, per loop

| Loop | Agents | People |
|---|---|---|
| [#22][i22] → [!26][mr26], Oct 17, merged | issue-builder proposed and opened the MR; mr-reviewer: ready, no fixes; GitLab Code Review: nothing to comment | Ahmed filed #22 and assigned it. Mazen gave the go-ahead. The guard failed on two gaps of its own, fixed by Mazen ([!28][mr28]) and Ahmed ([!29][mr29]). Ahmed checked the no-`python` corpus lane by hand ([before](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/jobs/17258572979): Python ran 1 of 4 tests; [after](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/jobs/17259651984): all 4, only the #21/#28 failures left), approved and merged. |
| [#12][i12] → [!50][mr50], Oct 18, merged | issue-builder proposed and opened the MR; mr-reviewer: ready, no fixes | Hamza filed #12. Ahmed assigned it, gave the go-ahead, ran the tests on Windows, which CI can't do (8 failures on `main`, 0 on the branch), approved and merged. |
| [#13][i13] → [!51][mr51], Oct 18, merged | issue-builder proposed and opened the MR; mr-reviewer [found a `remote push` example the CLI rejects](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/51#note_4036970240), fixed it in one round with a test that rejects the old form, then [re-reviewed: ready](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/51#note_4036994157) | Hamza filed #13. Ahmed gave the go-ahead to build it and [the go-ahead for the fix round](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/51#note_4036983381); [the guard checked each agent push against its own go-ahead](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/jobs/17262610558). Ahmed approved and merged. |
| [#4][i4] → [!54][mr54], Oct 18, merged | issue-builder proposed and opened the MR (a light theme, default output unchanged); mr-reviewer: ready, no fixes | Hamza filed #4 (a request from polyman's users). Ahmed gave the go-ahead, approved and merged. |
| [#45][i45], Oct 18, open | incident-responder filed it from the failed nightly; issue-builder's proposals for #21 and #28 are ready | Ahmed checked each finding, reopened #21, and merged the follow-ups ([!45][mr45], [!46][mr46], [!48][mr48]). Hamza gave the go-ahead for the fixes; [!73](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/73) is the one for #21. |

### Before and after

| | Before (GitHub, polyman 3.0.0) | After (GitLab) |
|---|---|---|
| CI | format, lint, unit tests with coverage (Node 20 and 22), build | the same, plus the corpus, mutation score, risk score, go-ahead guard, SAST and secret detection on every MR |
| Is the verdict right? | unit tests only | real compilers on every MR, and every night on the published package |
| Push to Polygon | trust the ✓ | read back from Polygon and compared, on `main` and nightly |
| Releases | no publish workflow | a person-clicked canary, judged as installed; npm `next` → judged against `latest` → `latest`, with provenance (built, first run with 3.0.1) |
| A live service | none | Cloud Run candidate checked by the golden set, manual promote, automatic rollback |
| Who finds the bugs | users (["Failed to upload generator"](https://github.com/HamzaHassanain/polyman/issues/19), April 2026) | the judges: 8 bugs so far |

### Claims and where to check them

| Claim | Evidence |
|---|---|
| The judges found 8 bugs the unit tests miss | corpus: [#21][i21], [#22][i22], [#23][i23], [#28][i28]; Polygon round trip: [#24][i24], [#25][i25], [#26][i26], [#31][i31] |
| The unit tests catch 314 of 463 bugs planted in the verdict code (67.8%) | [`corpus:mutation` on `main`](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/jobs/17262230236) |
| One wrong line passes all 974 unit tests, and the golden set catches it | [!5's pipeline](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/pipelines/2959006759), [`service:golden`](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/jobs/17258296779) |
| Duo's own security fix was checked by the judges, and a person finished it | [!57][mr57]: Duo Vulnerability Resolution's fix kept a sibling-folder hole; the corpus showed no verdict change, a person completed it ([b9e998a](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/commit/b9e998a)) ([#51](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/issues/51)) |
| An agent push without a go-ahead fails CI | [`autonomy:goahead` on !17](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/jobs/17258462748) |
| The nightly judges the published package, and an agent files what fails | [scheduled pipeline](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/pipelines/2959571332) → [#45][i45] |
| A failed production check rolls Cloud Run back by itself | [drill pipeline](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/pipelines/2959322051): check failed, [rollback](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/jobs/17260123329) ran, [#44][i44] opened as a drill |

### Honest limits

- Two Assisted loops have run end to end. No reviewer fix round has run yet: both reviews found nothing to fix.
- On !50 one person gave the go-ahead, approved and merged. The guard only keeps the go-ahead away from whoever asked: the issue's author, or the MR's if a person opened it.
- On Oct 17 at 19:40 pipeline-fixer removed !5's planted line by itself, before the Assisted flows ([!17][mr17]) and the guard ([!19][mr19]) were on `main`. A person put it back on Oct 18 ([e4ed065](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/commit/e4ed065)), and [its pipeline](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/pipelines/2959983252) is red again on [`service:golden`](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/jobs/17263548189). The guard now [refuses such a push](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/jobs/17258462748).
- GitLab Code Review didn't start when the reviewer flow asked for it (DCR4008 on !26 and !50); on !26 a person asked again and it ran.
- On MRs the `corpus` job may fail until #21 and #28 are fixed; the nightly `corpus:production` job may not.
- We don't claim time or memory parity with Polygon.

[mr4]: https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/4
[mr5]: https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/5
[mr17]: https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/17
[mr19]: https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/19
[mr26]: https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/26
[mr28]: https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/28
[mr29]: https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/29
[mr45]: https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/45
[mr46]: https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/46
[mr47]: https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/47
[mr48]: https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/48
[mr50]: https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/50
[i12]: https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/issues/12
[i13]: https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/issues/13
[i4]: https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/issues/4
[mr51]: https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/51
[mr54]: https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/54
[i21]: https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/issues/21
[i22]: https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/issues/22
[i23]: https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/issues/23
[i24]: https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/issues/24
[i25]: https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/issues/25
[i26]: https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/issues/26
[i28]: https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/issues/28
[i31]: https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/issues/31
[i44]: https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/issues/44
[i45]: https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/issues/45

### Who it's for, and why trust matters

polyman was announced to problem setters on [Codeforces in November 2025](https://codeforces.com/blog/entry/148803) (+332, 52 comments). The first thing the community asked was whether they could trust it: "Has anybody used this tool and can recommend it?", and another reply pointed out a tool that's brand new has no history and no user base yet. This project is our answer to that question: polyman is now checked by judges that are neither an LLM nor its authors, on every change and every night.

What we can say today, all public: about 1,950 npm downloads since September 2025 (downloads, not users: CI runs and mirrors count too), 12 versions, 41 stars and 4 forks on GitHub with five outside reporters or contributors, and two independent open-source projects that build on polyman's problem format.

Team: Hamza Hassanain (polyman's author), Mazen Ghanayem, Ahmed Faraj.

## Why Polyman?

Stop switching between environments. Create competitive programming problems entirely in your terminal:

- **Problem Templates** – Generate complete folder structures in one command  
- **Test Generation** – Automate test case creation with C++ generators  
- **Validation** – Validate inputs against problem constraints  
- **Multi-Solution Testing** – Test correct, wrong, TLE, and RE solutions simultaneously  
- **Smart Checkers** – Use standard checkers or write custom ones  
- **Complete Verification** – Full workflow in a single `verify` command  
- **Polygon Sync** – Pull problems, work locally, push changes back  
- **Multi-Language** – C++, Java, and Python support

Polyman eliminates manual testing and syncing, letting you focus on problem design.

## Installation

### System Requirements

- **Node.js** ^20.19.0 or ≥ 22.12.0
- **C++ Compiler** (g++ with C++23 support; set `cppStandard` in `Config.json` for older compilers)
- **Python 3** (optional - for Python solutions)
- **Java JDK** (optional - for Java solutions)

### Quick Install

```bash
npm install -g polyman-cli
```

Build from source:

```bash
git clone https://github.com/HamzaHassanain/polyman.git
cd polyman && npm install && npm run build && npm link
```

Verify: `polyman --version`

## Quick Start

### Create & Test a Problem

```bash
# Create new problem
polyman new my-problem
cd my-problem

# Download testlib (required for validators/generators)
polyman download-testlib

# Run complete verification
polyman verify
```

### Work with Polygon

```bash
# Setup (one-time)
polyman remote register

# Pull problem
polyman remote pull 123456 ./my-problem

# Work locally, then push back
polyman remote push . .
polyman remote commit . "Updated solutions"
```

## Commands

### Essential Commands

| Command                        | Purpose                         |
| ------------------------------ | ------------------------------- |
| `polyman new <dir>`            | Create new problem template     |
| `polyman download-testlib`     | Download testlib.h header       |
| `polyman generate --all`       | Generate all test cases         |
| `polyman validate --all`       | Validate test inputs            |
| `polyman run <solution> --all` | Run solution on all tests       |
| `polyman test <component>`     | Test validator/checker/solution |
| `polyman verify`               | Complete verification workflow  |
| `polyman verify --json`        | Same, as a JSON report on stdout |
| `polyman cache status`         | Show cached compiled binaries   |
| `polyman cache clear`          | Delete the compilation cache    |

### Polygon Commands

| Command                              | Purpose              |
| ------------------------------------ | -------------------- |
| `polyman remote register`            | Save API credentials |
| `polyman remote list`                | List your problems   |
| `polyman remote pull <id> <dir>`     | Download problem     |
| `polyman remote push <id> <dir>`     | Upload changes       |
| `polyman remote commit <id> "msg"`   | Commit changes       |
| `polyman remote package <id> <type>` | Build package        |

For detailed usage, see [GUIDE.md](GUIDE.md#cli-commands-reference).

### Compilation cache

C++ builds are cached in `.polyman/cache/` inside the problem directory. A source is recompiled only when it, a local header it includes (such as `testlib.h`), `cppStandard`, or the compiler version changes; otherwise the cached binary is reused and `verify` reports the time saved. Pass `--no-cache` to `generate`, `validate`, `run`, `test` or `verify` to force recompilation. See [GUIDE.md](GUIDE.md#compilation-cache).

### Shell completion

`polyman completion <bash|zsh|fish>` prints a completion script. Tab then completes commands, subcommands and options, and inside a problem directory it also completes testset names (`-t`), group names (`-g`, for the testset given before it), and solution names (`run <TAB>`, `test <TAB>`) read from `Config.json`. Without a `Config.json`, only commands and options are completed.

```bash
# bash: add to ~/.bashrc
eval "$(polyman completion bash)"

# zsh: add to ~/.zshrc, after compinit
eval "$(polyman completion zsh)"

# fish: save once
polyman completion fish > ~/.config/fish/completions/polyman.fish
```

The scripts are built from the CLI's own command list, so they stay current after an upgrade: re-run the line above (or reopen the shell, for `eval`). Installing the package does not change your shell setup.

### Scripting and AI agents

`run` and `verify` accept `--json`: stdout then carries exactly one JSON document and all human-readable output moves to stderr, so `polyman verify --json > verify.json` is safe to parse. The exit code is unchanged. `remote push` accepts `--yes` and `--name <slug>` so a new problem can be created without a terminal; without a TTY the command fails fast instead of waiting on a prompt. See [GUIDE.md](GUIDE.md#full-verification) for the report shape.

## Solution Tags

Every solution needs a tag indicating its expected behavior:

| Tag  | Meaning            | Purpose                                |
| ---- | ------------------ | -------------------------------------- |
| `MA` | Main Correct       | **Required** - Reference solution      |
| `OK` | Correct            | Alternative correct approach           |
| `WA` | Wrong Answer       | Should fail on some tests              |
| `TL` | Time Limit         | Should timeout on some tests           |
| `TO` | Time/OK            | May TLE but is algorithmically correct |
| `ML` | Memory Limit       | Should exceed memory                   |
| `RE` | Runtime Error      | Should crash                           |
| `PE` | Presentation Error | Wrong format                           |
| `RJ` | Rejected           | Should fail for any reason             |

For full details, see [GUIDE.md - Solution Types](GUIDE.md#solution-tags).

## Standard Checkers

Run `polyman list checkers` to see the full set with descriptions. The most useful:

| Checker            | Use For                          |
| ------------------ | -------------------------------- |
| `ncmp`             | Sequence of numbers (most problems) |
| `wcmp`             | Sequence of tokens/words         |
| `dcmp` / `rcmp*`   | Floating-point numbers           |
| `yesno`            | Yes/No answers                   |
| `lcmp`             | Exact line comparison            |

Full reference: [GUIDE.md - Standard Checkers](GUIDE.md#available-standard-checkers).

## Project Structure

After `polyman new my-problem`, you get:

```
my-problem/
├── Config.json              # Problem configuration
├── solutions/               # Solution files (main + WA/TL/etc)
├── generators/              # Test generators
├── validator/               # Input validator
├── checker/                 # Custom checker (if needed)
├── statements/              # Problem statements
└── tests/                   # Generated test files
```

See [GUIDE.md - Directory Structure](GUIDE.md#directory-structure) for full details.

## Configuration

The `Config.json` file defines your problem:

```json
{
  "name": "problem-name",
  "timeLimit": 2000,
  "memoryLimit": 256,
  "inputFile": "stdin",
  "outputFile": "stdout",
  "solutions": [
    {
      "name": "main",
      "source": "./solutions/main.cpp",
      "tag": "MA",
      "sourceType": "cpp.g++17"
    }
  ],
  "generators": [
    {
      "name": "gen",
      "source": "./generators/gen.cpp"
    }
  ],
  "checker": {
    "name": "ncmp",
    "isStandard": true
  },
  "validator": {
    "name": "validator",
    "source": "./validator/validator.cpp"
  },
  "testsets": [
    {
      "name": "tests",
      "generatorScript": {
        "script": "<#list 1..50 as i>\ngen ${i} > $\n</#list>"
      }
    }
  ]
}
```

See [GUIDE.md - Configuration Reference](GUIDE.md#configuration-file-reference) for complete documentation.

## Documentation

Choose your learning path:

### For Beginners

**[Complete User Guide](GUIDE.md)** - Comprehensive reference with configuration examples, validators, generators, checkers, and best practices.

### Step-by-Step

**[Step-by-Step Tutorial](TUTORIAL.md)** - Learn by creating a simple "Sum of Two Numbers" problem from scratch.

### For Developers

**[Technical Documentation](DOCUMENTATION.md)** - Architecture overview, type system, API reference, and implementation details.

### Platform-Specific

**[Windows Notes](NOTES.md)** - Important considerations for Windows users regarding line endings and process cleanup.

### API Reference

**[TypeDoc Documentation](https://hamzahassanain.github.io/polyman/)** - Generated API documentation for developers.

## Workflow Summary

1. **Create** → `polyman new my-problem`
2. **Setup** → `polyman download-testlib` + edit Config.json
3. **Implement** → Write solutions, validator, generator, checker
4. **Generate** → `polyman generate --all`
5. **Verify** → `polyman verify`
6. **Sync** → `polyman remote push .` + `polyman remote commit . "msg"`

Detailed walkthrough: [GUIDE.md - Workflow](GUIDE.md#workflow)

## Common Issues

**Q: My test times out. How do I debug?**  
See [GUIDE.md - Troubleshooting](GUIDE.md#troubleshooting) for performance tips and debugging strategies.

**Q: Do I need a custom checker?**  
For most problems, a standard checker like `wcmp` or `ncmp` is sufficient. See [GUIDE.md - FAQ](GUIDE.md#faq).

**Q: Windows users: Process not killed on TLE?**  
Check [NOTES.md](NOTES.md#solutions-validators-generators-and-checkers-that-exceed-the-time-limit) for cleanup instructions.

## Support

- **Issues**: [GitHub Issues](https://github.com/HamzaHassanain/polyman/issues)
- **Documentation**: [https://hamzahassanain.github.io/polyman/](https://hamzahassanain.github.io/polyman/)
- **Codeforces**: [https://codeforces.com/](https://codeforces.com/) • [Polygon](https://polygon.codeforces.com/)

## Contributing

Contributions welcome! To contribute:

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Make changes with clear commit messages
4. Push and open a Pull Request

Please ensure code follows the existing style and includes tests.

## License

MIT License. See [LICENSE](LICENCE) for details.

## Acknowledgments

- **testlib** by Mike Mirzayanov - Validators, generators, and checkers
- **Codeforces** - Platform and community
- **Contributors** - All who have helped improve Polyman
