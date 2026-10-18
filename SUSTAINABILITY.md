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
