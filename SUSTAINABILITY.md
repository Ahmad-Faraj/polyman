# What the agents cost the planet

Our agents run on GitLab: each Duo flow session is a CI job on a runner, and
its model calls run on GitLab's side. We count both, and say which part is
measured and which is estimated.

## The numbers in short

Functional unit: **one merge request review**. Model calls and tokens are counted
from every session's checkpoint; energy and grams per token are estimates with a
low and a high end (method below).

| Review depth (set by the risk score) | Reviews | Model calls | Tokens | gCO2e per review, low-high |
|---|---|---|---|---|
| high: security, code and test specialists | 105 | 38 | 1.62M | 6.8-56.2 |
| medium: code and test specialists | 26 | 30 | 1.23M | 5.0-44.8 |
| low: one light review | 16 | 7 | 0.35M | 1.2-10.4 |

Medians per review, Oct 16 to 18, before the cuts below. After them (reviewer 1.0.17, 9 full reviews) a full
review takes about 21 calls and 490k tokens, and about 6 GitLab credits instead of 11.

- **Inference is most of it.** The runner is about 1.9 g of a high review on average; the
  model calls are the rest. A carbon number that counts only CI misses most of
  what agents emit.
- **Depth follows risk: a low-risk review takes about 1/5 of the calls and
  tokens of a high-risk one.** The risk score comes from what changed (paths,
  size, new scanner findings on the lines it wrote), so a small documentation or
  test change doesn't get three specialists.
- **Sessions that didn't do their job.** Of 195 reviewer sessions to Oct 19
  01:10 UTC, 32 (16%) stopped early at about 2 calls each. Costlier were
  reviews that ended without their purpose: 26 finished after the MR had
  merged, 10 never posted their note, 7 repeated a head already reviewed. With
  the early stops that is 73 sessions and about 29% of the reviewer's credits.
  The reviewer now re-checks that the MR is open before it delegates; since
  1.0.17 it is 0 of 19 sessions so far.
- **A person's go-ahead decides whether a step runs at all.** An agent proposes
  first (a few turns) and builds only on a go-ahead; a proposal nobody approves
  never costs a build, a review and a pipeline (counted under "Per delivered
  fix").

## Per delivered fix

A review is only part of a fix. Functional unit two: **one judge-found bug fixed by agents on a person's go-ahead**, from the proposal to the merge: issue-builder's sessions (proposal and build), and every review, fix-round and GitLab Code Review session on its MR. Sessions as of 2026-10-18 14:30 UTC; same method as above.

| Issue | MR | Sessions | Runner gCO2e | Total gCO2e, low-high |
|---|---|---|---|---|
| #22 Python without `python` | !26 | 4 | 0.9 | 3.3-88 |
| #4 light theme | !54 | 3 | 1.0 | 3.6-77 |
| #12 Windows paths in tests | !50 | 4 | 1.5 | 5.0-122 |
| #13 outdated docs (one fix round) | !51 | 5 | 1.6 | 6.8-177 |
| #21 judge every test | !73 | 7 | 3.3 | 13-325 |
| #31 FreeMarker (one fix round) | !67, !83 | 10 | 5.4 | 19-465 |
| #8 shell completion | !59 | 11 | 25 | 66-865 |

**A merged fix, median: 6.8-177 gCO2e, of which the runner is 1.6 g.** What drives it is the number of review sessions, not the build: #8 had nine. (Session-to-issue matching is by the issue's "started session" notes; a session it can't place isn't counted, so these lean low.)

**The go-ahead decides what runs at all.** Of 13 proposals issue-builder posted, 2 never became a build: one nobody approved (#10), and one a maintainer revised before any code was written (#28, its first proposal would have stopped judging at the first PE). Each avoided build saves a build and its reviews, about one row of the table above. With a person deciding each step, a wrong or unwanted change costs a proposal (a few model calls), not a fix plus its reviews.

## Per token, with the calls counted (SCI for AI)

[SCI for AI](https://github.com/Green-Software-Foundation/sci-ai/blob/dev/SPEC.md) (Green Software Foundation) draws the consumer's boundary around inference and orchestration. It takes a language model's functional unit per token and an agentic workload's per workflow execution: here, one review. Each session's checkpoint holds every model reply with its usage, so this section counts the calls instead of bounding them from the log, and splits the tokens into four classes: uncached input, cache writes, cache reads and output.

232 sessions, from Oct 16 18:58 to Oct 18 17:39 UTC (2 more had no checkpoint):

| Flow | Sessions | Model calls | Tokens | Cache reads | Output |
|---|---|---|---|---|---|
| mr-reviewer | 176 (27 skipped) | 5,573 | 283.8M | 82% | 3.4% |
| issue-builder | 28 | 286 | 12.0M | 83% | 2.4% |
| pipeline-fixer | 12 | 82 | 3.6M | 78% | 0.9% |
| incident-responder | 5 | 28 | 1.5M | 75% | 1.1% |
| GitLab's own flows (Developer and others) | 11 | 59 | 0.9M | 29% | 4.0% |

Reviews by risk tier, median per review:

| Tier | Reviews | Model calls | Tokens | of which cache reads | gCO2e per review, low-high | gCO2e per 1M tokens, low-high |
|---|---|---|---|---|---|---|
| high | 105 | 38 | 1.62M | 1.28M | 6.8-56.2 | 3.5-28.6 |
| medium | 26 | 30 | 1.23M | 0.91M | 5.0-44.8 | 4.3-34.4 |
| low | 16 | 7 | 0.35M | 0.27M | 1.2-10.4 | 2.7-23.4 |

- **The reviewer is 94% of every token our agents used.** Builds, fixes and incidents together are 6%. Review depth, and which reviews run at all, is where savings are.
- **Counted calls narrow the range.** A high review averages 43.7 counted calls (8.0-65.2 g). Our first estimate (Oct 16-17, 43 high reviews) bounded them from the log at 41-99 calls (7.9-141.6 g): its low end holds, and its high end counted every checkpoint as a call.
- **Most input is a cache read.** That's 79% of a high review's tokens, and its uncached input is under 100 tokens. Output is about 3%. A per-token energy figure that assumes every input token is computed afresh would overstate this workload, so the energy stays per call (below), and none of the figures is measured for this model.
- **The security reviewer carries 38% of a high review's tokens with 27% of its calls.** It has the largest input per call: the scanner findings it pulled for the whole branch. Since !98 it gets only the findings on the lines the MR wrote.
- **The small model made the test reviewer dearer, so it went back.** !99 moved it to `claude-haiku-4-5`; in the 4 full reviews that followed it made 18 to 93 calls where it had made a median of 9, and edited files during reviews it was told only to report on. !107 put it back on the default model.

### What the cuts did (Oct 18)

The reviewer changed in two releases of the flow, at 16:41 and 17:47 UTC: !98 (only the scanner findings on the lines the MR wrote), !100 (the specialists chain their reads into fewer calls), !102 (the diff is read once, with git), !106 (the lead reads the tier and the assess job from the pipeline event) and !107 (above). Counted the same way as the table above, a full review:

| | Reviews | Model calls | Input tokens | GitLab credits |
|---|---|---|---|---|
| before !98 (median) | 72 | 40 | 1.69M | about 11 |
| after the cuts | 4 | 15-20 | 473k-618k | about 4.2-5.5 |

Credits are model calls divided by 3.6: that's what the calls of the sessions Mazen started came to on Mazen's GitLab credits usage on Oct 17 and 18 (3.58 and 3.62 calls per credit), against the 3.2 the price list gives.

Four reviews are few, and three of them were medium tier. The cuts also cost depth: on frozen copies of earlier MRs, re-reviewed with the new flow, the reviews found 4 of the 7 findings the earlier reviews of the same heads had found, and missed a command injection. !116 asks the specialists to save calls on lookups, never on testing; it is measured on the same frozen copies before any saving here counts as kept.

**Every loop, on the ledger.** The [go-ahead ledger](https://showcase-ce2cdc.gitlab.io/ledger/) has one row per agent-built change a person merged, with the grams of that loop's agent sessions by this method: every session on its issue and MRs up to the merge, runner time plus counted model calls. CI's job token can't read the session checkpoints, so the counts are committed in [sustainability/loop-sessions.json](sustainability/loop-sessions.json) with the time they are counted up to, and the ledger job reads them. To refresh it from a session count (one row per `duo_workflow` pipeline): `node engine/src/cli/loop-sessions.ts <sessions.json>`.

The data per session (pipeline, workflow, MR, tier, runner seconds, tokens by class and by role) is in [sustainability/agent-tokens.json](sustainability/agent-tokens.json). To rebuild it (read-only, needs a token that can read job logs and agent sessions):

    GITLAB_TOKEN=... node engine/src/cli/agent-tokens.ts <project path> --json sustainability/agent-tokens.json

## How it's calculated

SCI (Software Carbon Intensity, ISO/IEC 21031:2024): `(E x I + M) per R`.

- **Runner (measured time, modelled energy).** Each session's job duration
  from the GitLab API, turned into energy with Cloud Carbon Footprint
  coefficients for a GitLab.com small Linux runner (2 vCPU, 8 GB) on GCP
  us-east1: `.autonomy.yml` > `sustainability`, `engine/src/sci.ts`.
- **Model calls (bounded from the log, our first estimate for Oct 16-17; the
  counted section above replaces it).** The session log writes a checkpoint
  after every step of the agent graph: each model call, each tool step, the
  start and the finish. The high end is every checkpoint; the low end is the
  checkpoints that came 3 s or more after the one before (a completion takes
  seconds, most tool steps and bookkeeping take less than one). A slow tool
  step can pass for a model call, so the low end is a typical value, not a
  strict floor.
- **Energy per call (estimated, a cited range).** 0.24 Wh (Google's median
  Gemini Apps text prompt, serving overhead included, arXiv:2508.15734) to
  2.5 Wh (Epoch AI's rough estimate for a GPT-4o query with ~10k input
  tokens; agent calls carry the prompt, the event and the work so far).
  Neither is measured for the Claude model our flows use. The low end pairs
  the fewest calls with 0.24 Wh, the high end the most calls with 2.5 Wh.
  Grid intensity: us-east1's, 579 gCO2e/kWh (Google's 2025 region data; 560 in 2023); the flows' tool-call ids
  suggest the model is served on Google Cloud, but the region isn't published.
- **Embodied emissions**: per vCPU-hour for the runner; not included for the
  model's hardware.

CI does this on every MR and on `main` (job `autonomy:sci`): it rebuilds the
manifest from the sessions and fails if the committed one differs, runs
`if-run` on it and fails if any review's carbon differs from `engine/src/sci.ts`,
and measures CI's own runner footprint. The MR widget shows the figures against
`main` (metrics report), and the page is on Pages at
[/sci/](https://showcase-ce2cdc.gitlab.io/sci/).

Recompute it yourself, no token needed: every review's inputs and every step
of the arithmetic are in an [Impact Framework](https://if.greensoftware.foundation/)
manifest, [sustainability/agent-reviews.yml](sustainability/agent-reviews.yml)
(builtin Multiply and Sum only):

    npx -y -p @grnsft/if@1.1.1 if-run -m sustainability/agent-reviews.yml

`if-run` sums each tier's reviews, with every model call counted: for the high tier
it prints carbon-low 838.6 and carbon-high 6848.7 g, which over 105 reviews is the
8.0-65.2 g per review above (medium: 147.3 and 1175.9 g over 26; low: 22.9 and
198.3 g over 16). It calls `lsb_release`, so a minimal container needs that
installed, and `npm list` in its working directory, so run it after `npm ci` or
from another folder. To rebuild the manifest from the committed sessions (no
token): `node engine/src/cli/review-manifest.ts`. A test fails if the committed
manifest and `sustainability/agent-tokens.json` drift apart.

## What's not here yet

- A same-task before/after: the same MRs reviewed with tiering off (all high)
  and on. The table compares different MRs at different tiers.
- The verify service on Cloud Run (its energy per request).
