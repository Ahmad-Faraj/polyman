# What the agents cost the planet

Our agents run on GitLab: each Duo flow session is a CI job on a runner, and
its model calls run on GitLab's side. We count both, and say which part is
measured and which is estimated.

## The numbers (Showcase, 86 agent sessions, 2026-10-16 to 10-17)

Functional unit: **one merge request review**.

| Review depth (set by the risk score) | Reviews | Runner min | Runner gCO2e | Model calls, low-high | Total gCO2e, low-high |
|---|---|---|---|---|---|
| high: security, code and test specialists | 43 | 19.2 | 2.37 | 41-99 | 7.9-141.6 |
| low: one light review (+ GitLab Code Review) | 6 | 1.7 | 0.21 | 6-15 | 1.0-21.7 |

(One medium and one unclassified review are left out: one sample each.)

- **Inference is most of it.** On a high-risk review the runner is 2.4 g; the
  model calls add an estimated 5.5-139 g. A carbon number that counts only CI
  misses 70-98% of what agents emit.
- **Depth follows risk: a low-risk review costs 1/6 to 1/8 of a high-risk one**
  in total (1/11 of the runner time, about 1/7 of the model calls). The risk score comes from what
  changed (paths, size, new scanner findings on the lines it wrote), so a small
  documentation or test change doesn't get three specialists.
- **Triggers only fire for their own events.** Before we filtered pipeline
  triggers, 49% of reviewer sessions (18 of 37, in our sandbox) woke for a
  pipeline that wasn't theirs and stopped; on Showcase 20% of reviewer
  sessions (13 of 64) stopped early, for any reason (a pipeline not theirs, a
  head already reviewed, a fork).
- **A person's go-ahead decides whether a step runs at all.** An agent proposes
  first (a few turns) and builds only on a go-ahead; a proposal nobody approves
  never costs a build, a review and a pipeline. We'll count these once there
  are enough proposals to count.

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
| high | 105 | 38 | 1.62M | 1.28M | 6.5-54.4 | 3.4-27.7 |
| medium | 26 | 30 | 1.23M | 0.91M | 4.9-43.3 | 4.2-33.2 |
| low | 16 | 7 | 0.35M | 0.27M | 1.2-10.0 | 2.6-22.6 |

- **The reviewer is 94% of every token our agents used.** Builds, fixes and incidents together are 6%. Review depth, and which reviews run at all, is where savings are.
- **Counted calls narrow the range.** A high review averages 43.7 counted calls (7.7-63.1 g). The log bound in the first table is 41-99 calls (7.9-141.6 g): its low end holds, and its high end counted every checkpoint as a call.
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

The data per session (pipeline, workflow, MR, tier, runner seconds, tokens by class and by role) is in [sustainability/agent-tokens.json](sustainability/agent-tokens.json). To rebuild it (read-only, needs a token that can read job logs and agent sessions):

    GITLAB_TOKEN=... node engine/src/cli/agent-tokens.ts <project path> --json sustainability/agent-tokens.json

## How it's calculated

SCI (Software Carbon Intensity, ISO/IEC 21031:2024): `(E x I + M) per R`.

- **Runner (measured time, modelled energy).** Each session's job duration
  from the GitLab API, turned into energy with Cloud Carbon Footprint
  coefficients for a GitLab.com small Linux runner (2 vCPU, 8 GB) on GCP
  us-east1: `.autonomy.yml` > `sustainability`, `engine/src/sci.ts`.
- **Model calls (bounded from the log).** The session log writes a checkpoint
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
  Grid intensity: the runner's (560 gCO2e/kWh); the flows' tool-call ids
  suggest the model is served on Google Cloud, but the region isn't published.
- **Embodied emissions**: per vCPU-hour for the runner; not included for the
  model's hardware.

Recompute it yourself, no token needed: every review's inputs and every step
of the arithmetic are in an [Impact Framework](https://if.greensoftware.foundation/)
manifest, [sustainability/agent-reviews.yml](sustainability/agent-reviews.yml)
(builtin Multiply and Sum only):

    npx -y -p @grnsft/if@1.1.1 if-run -m sustainability/agent-reviews.yml

`if-run` sums each tier's reviews: for the high tier it prints carbon-low
340.4 and carbon-high 6088.3 g, which over 43 reviews is the 7.9-141.6 g per
review in the table (low tier: 6.0 and 130.1 g over 6). It calls
`lsb_release`, so a minimal container needs that installed. To rebuild the manifest from the job logs (read-only, needs a
token): `GITLAB_TOKEN=... node engine/src/cli/agent-footprint.ts <project path> --manifest sustainability/agent-reviews.yml`.

## What's not here yet

- A same-task before/after: the same MRs reviewed with tiering off (all high)
  and on. The table compares different MRs at different tiers.
- The verify service on Cloud Run (its energy per request).
