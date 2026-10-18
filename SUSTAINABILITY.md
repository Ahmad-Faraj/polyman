# What the agents cost the planet

Our agents run on GitLab: each Duo flow session is a CI job on a runner, and
its model calls run on GitLab's side. We count both, and say which part is
measured and which is estimated.

## The numbers (Showcase, 86 agent sessions, 2026-10-16 to 10-18)

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

## How it's calculated

SCI (Software Carbon Intensity, ISO/IEC 21031:2024): `(E x I + M) per R`.

- **Runner (measured time, modelled energy).** Each session's job duration
  from the GitLab API, turned into energy with Cloud Carbon Footprint
  coefficients for a GitLab.com small Linux runner (2 vCPU, 8 GB) on GCP
  us-east1: `.autonomy.yml` > `sustainability`, `engine/src/sci.ts`.
- **Model calls (bounded from the log).** The session log writes a checkpoint
  after every step of the agent graph: each model call, each tool step, the
  start and the finish. The high bound is every checkpoint; the low bound is
  the checkpoints that came 3 s or more after the one before (a completion
  takes seconds, tool steps and bookkeeping take less than one).
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

Reproduce: `GITLAB_TOKEN=... node engine/src/cli/agent-footprint.ts <project path>`
(read-only; it reads the job logs of the project's `duo_workflow` pipelines).

## What's not here yet

- A same-task before/after: the same MRs reviewed with tiering off (all high)
  and on. The table compares different MRs at different tiers.
- The verify service on Cloud Run (its energy per request).
- An Impact Framework manifest so anyone can recompute the numbers.
