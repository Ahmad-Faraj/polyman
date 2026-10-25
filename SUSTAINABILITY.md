# What the agents cost the planet

## Measured before and after, with the bar written down first

Each change was measured on the same inputs before and after, and kept only if its output stayed the same. "Bar set before" is ✔ only where the pass/fail rule was written down, with its time, before the measurement ran.

| Change | Bar set before | Before | After | Quality held | Evidence |
|---|---|---|---|---|---|
| The reviewer on `main` (E-B35, [!336](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/336)) | ✔ 24 Oct 11:35 UTC, before the first copy: at least 11 of 17, 3 of 5 held-out, no false P1, at most 10 new P1/P2, median at most 9.5 credits | 1.0.32: 7 of 17 original P1/P2 found at P1/P2 in two runs, 5.3 and 6.7 credits per review; the original reviews 13.1 | 13 of 17 in each of two runs, 7.8 and 8.1 credits per review, about 40% below the original reviews | no false P1; 4 of 5 findings on two held-out MRs (run 1) | the same 5 frozen MRs on identical diffs, 24 Oct; calls counted from each session's checkpoints, credits as calls / 3.6 ["The reviewer on `main`"] |
| CI: `corpus:survivors` reuses the unmutated build's g++ binaries ([!237](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/237)) | ✔ 21 Oct, before the code was written: every mutant outcome identical, and every after-run faster than every before-run | 185.1 runner-minutes per pipeline (median, 30 `main` pipelines) | 65.2 (8 pipelines), -64.8%, about 15.1 gCO2e less per pipeline | 116 of 116 mutant outcomes identical | jobs API durations of the 8 shards, 20-21 Oct ["What we cut, layer by layer"] |
| The verify service builds testlib.o and `<bits/stdc++.h>` once per image ([!248](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/248)) | measured, no prior bar (the MR listed byte-identical output as a merge condition) | the image before [!248](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/248); its candidate check: 5 golden calls, median 18.3 s | -57.4% CPU per verify (95% interval -59.7% to -54.9%); 9.4 s | 90 of 90 verifies byte-identical | the two CI-built images run locally, paired n=45, 22 Oct; latency from Cloud Run's request logs, n=5 each |
| The polyman CLI's precompiled header, as released in 3.1.0 on npm ([!282](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/282)) | ✔ 25 Oct 02:50 UTC, before any measurement: identical verdicts, tests and outputs in every run | 3.1.0 with `POLYMAN_PCH=0` | -28% CPU per cold verify (95% CI -33% to -24%), -18% per edit-and-reverify (-21% to -15%) | identical verdicts, tests, outputs and binaries in all 65 runs | same binary, PCH on against off, one 2-core laptop, paired n=15 each, 25 Oct ["What we cut, layer by layer"] |
| Rejected when they missed the bar: E-R ([!165](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/165)), E-R2 ([!200](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/200)), E-B34 | ✔ each bar written before its run | the reviewer before each change | E-R: 9 of 17 against a bar of 15, reverted in [!182](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/182); E-R2: 12 of 18 on five MRs it was never tuned on, against a bar of 15, reverted in [!234](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/234); E-B34: 13 of 17 but one false P1, and 35 P1/P2 raised of which 17 were real, not merged | none of the three is on `main` | findings read against the original review notes ["The change that was reverted", "The reviewer on `main`"] |

## Every MR measures itself

`autonomy:sci:pipeline` ([!252](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/252)) runs last in every MR and `main` pipeline and writes that pipeline's own runner-minutes, gCO2e and jobs counted to a metrics report, which GitLab's MR widget shows against the target branch: on [!330](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/330) it reads 3.58 gCO2e, 28.4 runner-minutes and 21 jobs against 15.91 g, 126.2 minutes and 40 jobs on `main` (the MR's metrics report, read 25 Oct). An MR pipeline runs fewer jobs than a `main` one, so that difference is not a saving; the job count is there so the reader can see it. `autonomy:sci` computes SCI per review from every agent session's counted model calls and runner time, the Green Software Foundation's Impact Framework (`if-run` 1.1.1) recomputes every review, and the job fails if the two differ; the go-ahead ledger turns the same sessions into grams per merged change (a median of 12-98 gCO2e, about 38 g central) and per delivered fix (11-91 g, about 26 g central) ["SCI at a glance"].

## What we cut, layer by layer

Each row says what was compared, how, when and on how many runs, and whether the output stayed the same. Grams per runner-hour are this page's 7.56 g (Cloud Carbon Footprint coefficients, us-east1, "How it's calculated").

| Layer | Change | Measured result | Same output? | How, when, n |
|---|---|---|---|---|
| Agent flows: the reviewer | the reviewer on `main` ([!336](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/336)), after the 18 Oct cuts and the changes measured below | median credits per review 13.1 for the original reviews against 7.8 and 8.1 in two runs, about 40% less | 13 of the 17 original P1/P2 findings found at P1/P2 in each run, no false P1 | the same 5 frozen MRs reviewed again on identical diffs, two runs, 24 Oct; calls counted from each session's checkpoints, credits as calls / 3.6 ["The reviewer on `main`"] |
| Agent flows: tokens and calls | the 18 Oct cuts (!98, !100, !102, !106) | a full review 40 → 21 model calls, 1.69M → 493k input tokens, about 11.1 → 5.8 credits (medians) | no: they cost depth, so !116 put testing back (7.6 credits) | 72 full reviews before, 9 after, different and mostly small MRs, 18 Oct ["What the cuts did"] |
| CI | `corpus:survivors` reuses the unmutated build's g++ binaries ([!237](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/237), 21 Oct) | survivors runner time per pipeline, median 185.1 → 65.2 runner-minutes (-64.8%, 95% interval -62.0% to -66.4%), about 15.1 g less per pipeline; at worst (fastest before against slowest after) 55.2 runner-minutes, 7.0 g | 116 of 116 mutant outcomes identical, mutant by mutant, in the 3 measured pipelines | jobs API durations of the 8 shards; 30 `main` pipelines before (20 Oct 17:40 to 21 Oct 18:08 UTC) against 8 after, every after-run faster than every before-run (Mann-Whitney p = 4.1e-8); before and after ran at different hours on shared runners. The bar was set before the code was written; on the 5 before-pipelines with the same inputs the cut was -57.6% |
| CI | `main` pushes that change none of the survivors' inputs skip them ([!238](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/238), 21 Oct) | replayed on the 29 `main` pushes before it: 20 would have skipped, 3,806.8 runner-minutes; live, 3 of the first 7 `main` pushes skipped (to 22 Oct 02:55 UTC), e.g. the docs-only [pipeline 2973864410](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/pipelines/2973864410) | a skipped run judges nothing; every CI file is on the input list, and the nightly runs survivors regardless | a replay of the rules on the earlier pushes' changed files, not a measurement; live count from the jobs API |
| CI | every pipeline reports its own runner footprint (`autonomy:sci:pipeline`, [!252](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/252), 22 Oct) | !252's own MR pipeline: 16 jobs, 24.8 runner-minutes, 3.13 gCO2e ([job](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/jobs/17380816777)); the first `main` run: 33 jobs, 111.7 runner-minutes, 14.08 gCO2e ([job](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/jobs/17391984728)) | a report, not a cut | job durations from the GitLab API in a `.post` job, the same runner coefficients; the `main` figure matched a separate count from the jobs API |
| The verify service | build testlib.o and `<bits/stdc++.h>` once per image, not per request ([!248](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/248), 22 Oct) | -57.4% CPU per verify (95% interval -59.7% to -54.9%), lower in 45 of 45 pairs; on Cloud Run the candidate check's 5 golden calls took a median of 9.4 s against 18.3 s for the revision before | 90 of 90 verifies byte-identical (tests, outputs, binaries, verdict JSON) | the two CI-built images run locally, 9 problems x 5 repetitions, paired n=45, user+system CPU of every process; latency from Cloud Run's request logs, n=5 each |
| The polyman CLI | a precompiled `<bits/stdc++.h>` per compiler and flags ([!282](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/282), shipped in 3.1.0) | CPU per cold verify -28% (bootstrap 95% CI -33% to -24%); per edit-and-reverify -18% (-21% to -15%) | identical verdicts, tests, outputs and binaries in all 65 runs | polyman 3.1.0 from npm, PCH on against `POLYMAN_PCH=0` with the same binary, on a 2-core i7-5600U laptop with g++ 13.3, 25 Oct; paired n=15 over 5 problems for each. Limits: one laptop, n=3 per problem and case, files on tmpfs; Windows and macOS were not measured again on 3.1.0 (the prototype was checked there for identical verdicts). On a full disk the PCH build fails cleanly, the compile goes on without it and the verify passes |

What these cuts cost is counted too: the warm verify instance adds 92-146 gCO2e a day during judging ["The warm verify instance"], and the agents' own grams are in every section below.

## SCI at a glance

**SCI = ((E × I) + M) per R** (Software Carbon Intensity, ISO/IEC 21031:2024). Every figure here is from a section further down, named in brackets.

- **One merged agent change: a median of 12-98 gCO2e, about 38 g central. One delivered fix: 11-91 g, about 26 g central.** 57 changes merged 17-24 Oct, 37 of them fixes built by issue-builder. Boundary: the proposal, build and review sessions up to the merge (runner time plus every counted model call, the same method as for reviews); not the loop's own CI pipelines, not the verify service. The low-high figures are the medians of the per-loop grams for the 57 loops of [ledger job 17443329261](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/jobs/17443329261) (25 Oct), with the sessions in the committed [sustainability/loop-sessions.json](sustainability/loop-sessions.json) (counted to 25 Oct 00:32 UTC; every loop counted, none partly); the central is an estimate per output token ["Per delivered fix", "How it's calculated"].
- **R, the functional unit: one full merge request review.** Also per loop: one agent-built change a person merged, from the proposal to the merge (the [go-ahead ledger](https://showcase-ce2cdc.gitlab.io/ledger/), and "Per delivered fix").
- **E, energy:** counted model calls × 0.24-2.5 Wh per call, plus runner time. 0.24 Wh is Google's median Gemini Apps text prompt (arXiv:2508.15734), 2.5 Wh Epoch AI's estimate for a GPT-4o query with ~10k input tokens; neither is measured for the model our flows use. Calls are counted from each session's checkpoints. Runner time is the job duration from the GitLab API, turned into energy with Cloud Carbon Footprint coefficients for a 2 vCPU, 8 GB runner (7.56 g per runner-hour) ["How it's calculated", "Same diffs"].
- **I, grid intensity:** 579 gCO2e/kWh, us-east1 (Google's 2025 region data). The model's serving region isn't published ["How it's calculated"].
- **M, embodied:** per vCPU-hour for the runner (1.2 g per vCPU-hour); not included for the model's hardware ["How it's calculated", "The warm verify instance"].
- **The gain, on the same diffs (n=5):** the same five MRs, frozen at the heads of their first reviews, reviewed again. Median per review 8.4-70.0 → 4.0-31.1 gCO2e, and 13.1 → 5.8 credits (original reviews against reviewer 1.0.25), which found 11 of the 17 original P1/P2 findings at P1/P2. **The reviewer on `main` now:** 13 of 17 in each of two runs (Oct 24), at a median of 7.8 and 8.1 credits per review, about 40% below the original reviews; 1.0.32 found 7 of 17 in two runs ["Same diffs, three reviewer versions", "The reviewer on main"].
- **Changes that failed their bar and were dropped:** E-R, a rule to reproduce each P1/P2 before rating it: the bar, written before the rerun, was at least 15 of 17; it found 9 of 17, so !182 reverted it. E-R2, the same rule plus a P2 floor for reproduced harm, pre-registered in [!200](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/200) and run on five MRs it was never tuned on: 12 of 18 against a bar of 15 (the reviewer then on `main` found 13), so [!234](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/234) reverted it. E-B34 found 13 of 17 but raised one false P1 and 35 P1/P2 findings of which only 17 were real, so it was not merged ["The change that was reverted", "The reviewer on main"].
- **The warm verify instance (judging window), counted too:** 92-146 gCO2e per day, 2,500-4,000 g for 20 Oct to 16 Nov (an upper bound), about the grams of 4 to 18 high-risk reviews a day. It saves a judge's first verify a 23.6 s cold start and goes back to 0 after judging ["The warm verify instance"].
- **How to recompute:** the per-tier review figures (Oct 16-25, all reviewer versions) are in an Impact Framework manifest, [sustainability/agent-reviews.yml](sustainability/agent-reviews.yml), builtin Multiply and Sum only: `npx -y -p @grnsft/if@1.1.1 if-run -m sustainability/agent-reviews.yml`. The same-diff figures come from the session ids listed under "How it was verified", by the same method.

Our agents run on GitLab: each Duo flow session is a CI job on a runner, and
its model calls run on GitLab's side. We count both: every model call of every
agent session, read from the session's checkpoints, and each session's runner
time from the GitLab API. The committed data has 949 sessions, Oct 16 18:58 to
Oct 25 00:32 UTC. We say which part is measured and which is estimated.

## The numbers in short

Functional unit: **one merge request review**. Model calls and tokens are counted
from every session's checkpoint; energy and grams per token are estimates with a
low and a high end (method below).

| Review depth (set by the risk score) | Reviews | Model calls | Tokens | gCO2e per review, low-high |
|---|---|---|---|---|
| high: security, code and test specialists | 401 | 28 | 0.96M | 5.0-41.4 |
| medium: code and test specialists | 112 | 19.5 | 0.70M | 3.6-29.2 |
| low: one light review | 66 | 5 | 0.26M | 0.9-7.5 |

Medians per review, Oct 16 18:58 to Oct 25 00:32 UTC, every reviewer version together, before and after the
cuts below (from the committed [sustainability/agent-tokens.json](sustainability/agent-tokens.json)). When the file
stopped at Oct 18 17:39 UTC (counted on Oct 18), the same table read high
105 reviews, 38 calls, 1.62M tokens, 6.8-56.2 g; medium 26, 30, 1.23M, 5.0-44.8 g; low 16, 7, 0.35M, 1.2-10.4 g.
After the cuts (reviewer 1.0.17, 9 full
reviews, Oct 18 17:58 to 23:26 UTC) a full review takes a median of 21 calls and 493k input tokens, and about
5.8 GitLab credits instead of 11.1 (72 full reviews before), on mostly small MRs.
Median credits per full review by reviewer version, counted from every session's checkpoints to Oct 19 20:03 UTC:
before the cuts 11.1 (n=72), 1.0.17 5.8 (n=9), 1.0.18 7.6 (n=12), 1.0.21 7.6 (n=6), 1.0.22-1.0.24 8.6 (n=13).
The later versions spend more, partly on purpose: since !116 the specialists save calls on lookups, never on
testing. Their test runs went from a median of 3 to 9 per full review and their calls from 14 to 24 (1.0.17
against 1.0.22-1.0.24), while the lead stayed at 7 to 8 calls. The later reviews were also of bigger MRs
(651 changed lines on average, against 114) and mostly re-reviews (10 of 13, 9 of them asked for by a
person), so we don't split the rise between testing and MR size.

- **Most of it is the model calls, so we count every one.** The runner is about 1.3 g
  of a high review on average (Oct 16-25); the model calls are the rest, 76-97% of
  its estimated total.
- **Depth follows risk: a low-risk review takes about 1/5 of the calls and
  about 27% of the tokens of a high-risk one** (medians: 5 calls and 263k tokens
  against 28 and 958k). The risk score comes from what changed (paths,
  size, new scanner findings on the lines it wrote), so a small documentation or
  test change doesn't get three specialists.
- **Sessions that didn't do their job.** Of 176 reviewer sessions before
  reviewer 1.0.17 (Oct 16 18:58 to Oct 18 17:39 UTC), 73 ended without their
  purpose: 32 stopped at the start without a review, 26 finished after the MR
  had merged, 10 never posted their note, and 5 more repeated a head already
  reviewed. That was 31% of the reviewer's credits. The reviewer now skips MRs
  that aren't open and re-checks before it delegates (!106, !116). From 1.0.17
  to Oct 19 20:03 UTC it is 20 of 88 sessions, but 14 of those are short stops
  (2 calls or fewer, 12 of them on an MR already reviewed, the stop !132
  designed). The real waste is 6 sessions: 3 failed on platform errors before
  posting, 2 repeated a head when a pipeline event and a mention started in the
  same minute, and 1 finished after a person merged the MR. That is 8% of the
  reviewer's credits, against 31% before.
- **Re-reviews: no saving to claim.** Before !132 (Oct 16 18:58 to Oct 19
  12:51 UTC), a later review of an MR already reviewed was 62 of 164 reviews,
  39% of the reviewer's input tokens and 37% of its credits. Since !132 a
  pipeline event on an already-reviewed MR stops after 2 calls (8 of 12 such
  sessions to Oct 19 20:03 UTC). But people asked for re-reviews: in the same
  hours they were 17 of 30 reviews (15 started by a mention) and 53% of the
  reviewer's credits.
- **A person's go-ahead decides whether a step runs at all.** An agent proposes
  first (a few turns) and builds only on a go-ahead; a proposal nobody approves
  never costs a build, a review and a pipeline (counted under "Per delivered
  fix").

## Per delivered fix

A review is only part of a fix. Functional unit two: **one judge-found bug fixed by agents on a person's go-ahead**, from the proposal to the merge: issue-builder's sessions (proposal and build), and every review, fix-round and GitLab Code Review session on its MR. Counted from every session's checkpoints to Oct 19 20:03 UTC, for the 15 issue-builder fixes merged by then; sessions are matched by issue (issue-builder) and by MR or branch (reviews). Credits are estimated as above.

| Issue | MR | Sessions (issue-builder + reviews) | Model calls | Credits (estimated) | gCO2e, low-high (ledger) |
|---|---|---|---|---|---|
| #22 | !26 | 5 (2 + 3) | 31 | 8.6 | 4.7-40.0 |
| #12 | !50 | 3 (2 + 1) | 32 | 8.9 | 5.5-47.4 |
| #13 | !51 | 5 (2 + 3) | 58 | 16.1 | 10.0-85.9 |
| #4 | !54 | 3 (2 + 1) | 24 | 6.7 | 4.3-35.7 |
| #8 | !59 | 9 (2 + 7) | 270 | 75.0 | 65.0-434.0 |
| #21 | !73 | 3 (2 + 1) | 59 | 16.4 | 10.7-93.1 |
| #31 | !67, !83 | 9 (2 + 7) | 143 | 39.7 | 25.2-212.3 |
| #26 | !74, !87 | 7 (3 + 4) | 130 | 36.1 | 22.4-197.7 |
| #24 | !72, !86 | 6 (2 + 4) | 156 | 43.3 | 25.8-229.9 |
| #28 | !85, !92 | 5 (3 + 2) | 130 | 36.1 | 21.4-191.5 |
| #25 | !75, !95 | 9 (2 + 7) | 253 | 70.3 | 43.1-374.2 |
| #58 | !101 | 2 (2 + 0) | 16 | 4.4 | 2.9-23.8 |
| #62 | !136 | 9 (2 + 7) | 145 | 40.3 | 26.6-216.3 |
| #82 | !143 | 6 (3 + 3) | 79 | 21.9 | 14.4-117.8 |
| #29 | !146 | 3 (2 + 1) | 27 | 7.5 | 4.9-40.2 |

The gCO2e column is the go-ahead ledger's per-loop grams (the same rows as in [job 17424130908](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/jobs/17424130908), run 23 Oct 17:23 UTC; recomputed on 25 Oct with the sessions counted to 25 Oct 00:32 UTC, these 15 rows do not change). It uses the same session matching, but with sessions counted later than the columns to its left, so for !26, !59 and !73 it has one or two sessions more or less. Each session is its runner seconds at 7.56 g per runner-hour (Cloud Carbon Footprint coefficients, 579 g/kWh, embodied 1.2 g per vCPU-hour) plus its counted model calls × 0.24-2.5 Wh × 579 g/kWh, the method we use for reviews. Over every loop on the ledger, 57 changes merged 17 Oct 23:00 to 24 Oct 23:29 UTC, the median is 12-98 gCO2e per merged change (11.8-98.2), and 11-91 g (11.2-91.1) over the 37 fixes built by issue-builder. To recompute: take the 57 "loop !N ... gCO2e" rows of the ledger job log on `main` (from the first `main` pipeline that has this sessions file) and the median of the low and the high end separately. In the boundary: the proposal, build and review sessions of the loop up to the merge. Not in it: the loop's own CI pipelines (tests, assess, deploy), the verify service, and reviews after the merge.

**A merged fix, median: 5 sessions, 79 model calls, about 22 credits, 14-118 gCO2e.** What drives it is the number of review sessions, not the build: #8, #31, #25 and #62 had seven each. (One #26 session recorded no usage, so its calls lean low.)

**The go-ahead decides what runs at all.** issue-builder posted proposals on 23 issues (its issue notes, to Oct 19 20:50 UTC); 21 became an MR. Two never pushed code by then: #10, a critical path where only a maintainer's go-ahead counts, and when it was proposed the one maintainer was the person who filed it (built on a maintainer's go-ahead on 22 Oct, [!261](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/261), merged 23 Oct), and one where the agent stopped when `npm audit fix` hit an npm error, as its proposal said it would (#63). On #28 a maintainer revised the first proposal before any code was written (it would have stopped judging at the first PE). Each avoided build saves a build and its reviews, about one row of the table above. With a person deciding each step, a wrong or unwanted change costs a proposal (a few model calls), not a fix plus its reviews.

## Per token, with the calls counted (SCI for AI)

[SCI for AI](https://github.com/Green-Software-Foundation/sci-ai/blob/dev/SPEC.md) (Green Software Foundation) draws the consumer's boundary around inference and orchestration. It takes a language model's functional unit per token and an agentic workload's per workflow execution: here, one review. Each session's checkpoint holds every model reply with its usage, so this section counts the calls instead of bounding them from the log, and splits the tokens into four classes: uncached input, cache writes, cache reads and output.

949 sessions, from Oct 16 18:58 to Oct 25 00:32 UTC, every flow version together (all in the committed sessions file; `node engine/src/cli/sci-report.ts` prints these tables from it):

| Flow | Sessions | Model calls | Tokens | Cache reads | Output |
|---|---|---|---|---|---|
| mr-reviewer | 778 (193 skipped) | 15,038 | 637.0M | 75% | 3.4% |
| issue-builder | 94 | 1,014 | 46.7M | 86% | 1.6% |
| pipeline-fixer | 52 (9 skipped) | 370 | 18.0M | 82% | 1.0% |
| incident-responder | 14 | 88 | 4.9M | 76% | 1.1% |
| GitLab's own flows (Developer and others) | 11 | 59 | 0.9M | 29% | 4.0% |

Reviews by risk tier, median per review:

| Tier | Reviews | Model calls | Tokens | of which cache reads | gCO2e per review, low-high | gCO2e per 1M tokens, low-high |
|---|---|---|---|---|---|---|
| high | 401 | 28 | 0.96M | 0.70M | 5.0-41.4 | 4.3-35.0 |
| medium | 112 | 19.5 | 0.70M | 0.51M | 3.6-29.2 | 4.6-38.0 |
| low | 66 | 5 | 0.26M | 0.18M | 0.9-7.5 | 3.3-26.6 |

- **The reviewer is 90% of every token our agents used.** Builds, fixes and incidents together are 10%. Review depth, and which reviews run at all, is where savings are.
- **Counted calls narrow the range.** A high review averages 29.9 counted calls (5.4-44.5 g).
- **Most input is a cache read.** That's 73% of a high review's tokens (0.70M of 0.96M, medians), and its uncached input is under 100 tokens (median 64). Output is about 3%. A per-token energy figure that assumes every input token is computed afresh would overstate this workload, so the energy stays per call (below), and none of the figures is measured for this model.
- **The security reviewer carries 25% of a high review's tokens with 24% of its calls**, and the lead 37% with 23%. In the Oct 16-18 sessions it carried 38% with 27%: it had the largest input per call, the scanner findings it pulled for the whole branch. Since !98 it gets only the findings on the lines the MR wrote.
- **The small model made the test reviewer dearer, so it went back.** !99 moved it to `claude-haiku-4-5`; in the 5 full reviews that followed it made 18 to 93 calls (median 43) where it had made a median of 9 (72 full reviews before), and a full review took a median of 57 calls instead of 40. It also edited files during reviews it was told only to report on. !107 put it back on the default model.

### What the cuts did (Oct 18)

The reviewer changed in two releases of the flow, at 16:41 and 17:47 UTC: !98 (only the scanner findings on the lines the MR wrote), !100 (the specialists chain their reads into fewer calls), !102 (the diff is read once, with git), !106 (the lead reads the tier and the assess job from the pipeline event) and !107 (above). Counted the same way as the table above, but from every session to Oct 19 20:03 UTC (counted on Oct 19, with reviewer versions told apart; the committed file now runs to Oct 25 00:32 and mixes them), a full review:

| | Reviews | Model calls | Input tokens | GitLab credits |
|---|---|---|---|---|
| before !98 (median) | 72 | 40 | 1.69M | about 11 |
| after the cuts (reviewer 1.0.17, median) | 9 | 21 | 493k | about 5.8 |
| 1.0.18 (!116: never save on testing) | 12 | 27.5 | 791k | about 7.6 |
| 1.0.21 | 6 | 27.5 | 907k | about 7.6 |
| 1.0.22-1.0.24 (to Oct 19 20:03 UTC) | 13 | 31 | 1.16M | about 8.6 |

Credits are model calls divided by 3.6: that's what the calls of the sessions Mazen started came to against his billed credits (GitLab's credits usage API, read Oct 19 20:50 UTC): 1,022 calls for 285.3 credits on Oct 17 (3.58 per credit) and 1,126 calls for 317.4 credits on Oct 18 (3.55). Oct 19 is not closed and its partial counts came to about 3.0, so these credits may be up to about 20% low.

The nine reviews after the cuts were on small MRs (median 52 lines). The cuts also cost depth: on frozen copies of three earlier MRs (!110, !111, !113), reviewer 1.0.17 found 8 of the 14 known findings at P1-P2 (3 more as P3), against 9 for the original reviews of the same heads (#61), and rated the command injection in !59 (P1 in the original review) as P3. !116 asks the specialists to save calls on lookups, never on testing; it was written after that miss, and on the frozen copy of !67 (!124) reviewer 1.0.18 then found 4 of its 5 findings, against 3 of 5 for 1.0.17. On a later frozen copy of !59 (!145, one run) whose description named the injection as the thing being measured, reviewer 1.0.22 rated it P1 with a working exploit in 19 calls (about 5.3 credits), against 47 calls (about 13.1 credits) for the original review. Because the description named the target, and the prompt line it tests was written from this finding, that run shows the rating rule works once the bug is in view; it is not a blind recall result. The same-diff benchmark of five MRs below measures cost and findings together.

**Every loop, on the ledger.** The [go-ahead ledger](https://showcase-ce2cdc.gitlab.io/ledger/) has one row per agent-built change a person merged, with the grams of that loop's agent sessions by this method: every session on its issue and MRs up to the merge, runner time plus counted model calls. CI's job token can't read the session checkpoints, so the counts are committed in [sustainability/loop-sessions.json](sustainability/loop-sessions.json) with the time they are counted up to, and the ledger job reads them. With sessions counted up to Oct 25 00:32 UTC, the 57 loops of [ledger job 17443329261](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/jobs/17443329261) come to 825-6,828 gCO2e in all, every loop counted (computed with the ledger's own `loopGrams()` on the committed file; the ledger job on `main` prints the same total once this file is there). The last loop, !330, merged at 23:29 UTC on Oct 24, before the cut-off. To refresh it from a session count (one row per `duo_workflow` pipeline): `node engine/src/cli/loop-sessions.ts <sessions.json>`.

The data per session (pipeline, workflow, MR, tier, runner seconds, tokens by class and by role) is in [sustainability/agent-tokens.json](sustainability/agent-tokens.json). To rebuild it (read-only, needs a token that can read job logs and agent sessions):

    GITLAB_TOKEN=... node engine/src/cli/agent-tokens.ts <project path> --json sustainability/agent-tokens.json

## Same diffs, three reviewer versions (n=5, Oct 18-20)

The tables above compare different MRs. Here five earlier MRs were reviewed again on identical diffs, so cost and findings can be set side by side.

**Setup.** !59, !67, !69, !74 and !75 had their first full review on Oct 18 between 06:50 and 13:00 UTC, before the cuts (!98 and !100 went out at 16:41). Each was frozen at the head that review covered, against the same base, as a Draft MR: !153-!157 were reviewed by reviewer 1.0.25 (Oct 19, 20:20-21:50 UTC) and !170-!174 by 1.0.26 (Oct 20, 02:07-02:58 UTC). The 1.0.26 copies are new commits with the same tree and parent as the 1.0.25 copies, so the diffs are byte-identical. The !59 copy's base also has two later CI commits; no CI file is in its diff. The risk tier and score matched the original review on all five (medium 37, medium 32, high 45, medium 50, high 65). Each copy was reviewed once, started by one "please review" mention after its pipeline passed. Two differences from the originals: the original !69 review was started by a pipeline event, and the new descriptions said the MR is a frozen copy. Every call, before and after, ran the same model.

**Blind?** An audit of the scored replays' session traces on Oct 20 (#92, !178) found that they read only their own MR, the issue it references and the frozen branches, never the original MR, its notes, the fix commits or `main`. The one exception is !145 (above), whose description named the bug. The !59 copy is also on the tuning set: the prompt lines in !116 and !125 were written from its miss.

**Reference.** The P1/P2 findings in each original review note: 17 in all, one of them P1. A finding counts as found when the new review names the same bug at P1 or P2.

| Per review, same 5 diffs | Original first reviews (Oct 18) | 1.0.25 (!153-!157) | 1.0.26 with E-R (!170-!174) |
|---|---|---|---|
| Model calls, median (total) | 47 (202) | 21 (116) | 25 (118) |
| GitLab credits, median (total) | 13.1 (56.1) | 5.8 (32.2) | 6.9 (32.8) |
| gCO2e, median low-high | 8.4-70.0 | 4.0-31.1 | 4.4-37.1 |
| Original P1/P2 found at P1/P2 | 17 of 17 (the reference) | 11 of 17 | 9 of 17 |
| Original P1/P2 found at any severity | 17 of 17 | 13 of 17 | 14 of 17 |
| !59's P1 (bash completion runs a hostile name) rated | P1 | P2 | P1 |
| New P1/P2 not in the original | - | 6 | 9 |
| False P1 | - | 0 | 0 |

How it was verified:
- Calls and tokens: counted from each session's checkpoints by our usage collector, run Oct 19 ~22:10 UTC (original and 1.0.25 sessions) and Oct 20 ~02:55 UTC (1.0.26). Sessions, in the order !59, !67, !69, !74, !75: original 9647835, 9650466, 9650589, 9651005, 9650982; 1.0.25 9712171, 9713640, 9713962, 9715017, 9715434; 1.0.26 9721513, 9721782, 9721956, 9722103, 9722210.
- Credits: calls divided by 3.6, as above.
- gCO2e: this page's method with every call counted: calls x 0.24-2.5 Wh x 579 g/kWh, plus the session's runner seconds at 7.56 g per runner-hour (the runner coefficients below). The low and high medians are taken separately.
- Findings: each new review note on !153-!157 and !170-!174, read against the P1/P2 list in the original review note on !59, !67, !69, !74 and !75. Some new findings are P3s of the original, raised. In both runs one original P2 came back as a P1 with better evidence (!67's `@group` regression on 1.0.25, !75's swallowed `clearTestset` failure on 1.0.26); neither is counted as false.

### The change that was reverted (E-R)

On 1.0.25 the four missed findings were all bugs that show only when the code runs, and the specialists ran the MR's code in 23 calls over the five reviews, against 44 in the originals. !165 added one rule for the specialists: reproduce each P1/P2 by running code before rating it, write "reproduced: command -> output" or "not reproduced: why" under it, and rate an unreproduced bug at most P2. The bar was written down before the rerun: keep it only if at least 15 of the 17 are found at P1/P2, !59's P1 is rated P1, and the median stays below about 9 credits.

Result on 1.0.26 (!165, tightened by !168): **9 of 17, so it failed the bar.** The other two conditions passed: !59's P1 was rated P1, reproduced in an interactive shell, and the median was 6.9 credits. 15 of the 19 P1/P2 it reported carry a reproduction. The loss was mostly in rating, not detection (14 of 17 found at any severity): on !69, a prompt change in a flow file with nothing to run, both original P2s were found and rated P3. As the bar said, !165 was reverted in !182 (Oct 20, 11:45 UTC; reviewer 1.0.28). The revert keeps !168's shorter reviewer prompt, whose rating and sandbox sentences mean the same as 1.0.25's, and !184's rule that agents don't fix protected paths. Rerun on 23 Oct (E-B32) on the same 5 copies: 28.6 credits against 56.1 (about half), but it found 7 of 17 P1/P2 findings against 11 for 1.0.25. The fix for that gap is measured under "The reviewer on `main`" below. A third rule failed its bar too: E-R2 ([!200](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/200), pre-registered before any of its reviews ran) brought the reproduce rule back with a P2 floor and found 12 of 18 on five MRs it was never tuned on, against a bar of 15, while the reviewer then on `main` found 13 of 18 at a median of 7.22 credits; [!234](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/234) reverted it on 21 Oct. The copies are [!270](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/270), [!271](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/271), [!272](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/272), [!273](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/273), [!274](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/274) (closed, with their review notes), reviewed by reviewer 1.0.32; calls are counted from the session checkpoints and credits are calls divided by 3.6, as above.

A gap of 11 against 9 is inside run-to-run variance: earlier reruns of the same copies swung by a whole P1. So the rerun doesn't show that 1.0.26 was worse than 1.0.25, only that it didn't reach the bar set before it ran.

### What we claim from it (1.0.25)

These were the claims for reviewer 1.0.25; the reviewer on `main` now is measured in the next section.

- **About half the credits and carbon per full review on the same diffs:** median 13.1 to 5.8 credits, 8.4-70.0 to 4.0-31.1 gCO2e (1.0.25 against the original reviews).
- **About two thirds of the original P1/P2 findings** (11 of 17 at P1/P2), plus 6 new ones, and no false P1. Not the same quality at half the cost: four original findings were missed, and the one P1 was rated P2.
- **Caveats:** n=5, one run per version, and the original reviews are single runs too.
- **What the benchmark cost:** about 33.6 credits for the 1.0.25 run (5 reviews 32.2, plus 1.4 for five one-call "draft MR" skips) and about 39.7 for the 1.0.26 rerun (reviews 32.8, draft skips 1.4, two pipeline-fixer sessions on an apt timeout 3.9, two refused tries on a reopened copy 1.7). All copies were closed, not merged.

### The reviewer on `main` (E-B35, two runs, Oct 24)

After the 1.0.32 result we changed the reviewer once more and measured it on the same five frozen copies, against a bar written down before the first run: at least 11 of 17 found at P1/P2, at least 3 of 5 on two MRs it was not tuned on, no false P1, at most 10 new P1/P2 findings over the five reviews, and a median of at most 9.5 credits per review. Run 2 had to hold the recall, no-false-P1 and new-findings bars again before the change could merge. The change: the specialists may run the MR's code in a sandbox copy and follow a checklist of what to hunt for, a bug is rated by what the code does, a P2 floor applies only on lines the diff touches, test gaps are P2 only when a behaviour has no test, and the evidence decides when two reviewers disagree. It is the text on `main` since Oct 24 ([!336](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/336), merged by a maintainer).

| Same 5 diffs | Original first reviews (Oct 18) | 1.0.32, two runs (Oct 23) | Reviewer on `main`, run 1 | Reviewer on `main`, run 2 |
|---|---|---|---|---|
| Original P1/P2 found at P1/P2 | 17 of 17 (the reference) | 7 of 17, 7 of 17 | 13 of 17 | 13 of 17 |
| P1/P2 in the five review notes, of them real | - | - | 19, 17 real | 22, 19 real |
| New P1/P2 not in the original | - | - | 5 | 8 |
| False P1 | - | - | 0 | 0 |
| GitLab credits per review, median (total of 5) | 13.1 (56.1) | 5.3 (28.6), 6.7 (35.3) | 7.8 (43.1) | 8.1 (41.9) |
| Two held-out MRs (5 findings), found at P1/P2 | - | - | 4 of 5 | not run |

- **Run 2's one P1 was a level too high.** It is a real bug (a failed testset clear only printed a warning and the push exited 0, on a path the MR newly reaches), and the original review rated it P2. A maintainer judged it real, not a false P1.
- **The extra cost is the specialists running code.** The median is about 8 credits per review, against 5.3 and 6.7 for 1.0.32's two runs, and still about 40% below the original reviews' 13.1.
- **What we tried first and dropped (E-B34).** The same change plus "keep the higher of two ratings" and a floor on any reachable line reached the same recall, 13 of 17, but raised 35 P1/P2 findings on the five MRs, of which 17 were real, and one false P1 on old lines the MR did not touch. It failed its bar and was not merged. E-B35 keeps the recall and removes most of that noise.

How it was verified:
- The copies are new commits with the same trees and bases as the earlier copies, so the diffs are identical; the risk tier and score matched the originals on all five, and each review started from one mention, one copy at a time. Run 1: [!302](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/302), [!303](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/303), [!315](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/315), [!322](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/322), [!323](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/323), held-outs [!324](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/324) (copy of !72) and [!325](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/325) (copy of !40). Run 2: [!331](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/331) to [!335](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/merge_requests/335). All closed, with their review notes.
- Each session's trace was read: every review started exactly its tier's specialists, and none read the original MR, its notes or another copy.
- Calls are counted from each session's checkpoints and credits are calls divided by 3.6, as above.
- Findings: each P1/P2 in the five review notes, read against the original P1/P2 list and labelled real, rated too high, or false on the copy's own code, with a probe or a mutation run where that settles it. A second check of the scoring reached the same counts, and the one disputed rating was decided by a maintainer.

Known limits:
- Tuning set: the change was written from the traces of these same five tasks, so 13 of 17 is a fix check on them, not a blind recall result. The two held-out MRs were reviewed in run 1 only.
- 4 of the 17 reference findings are still missed or rated only P3 in each run (two of them missed in both).
- The P1 rule for "a check, a gate or a guard" can still be read too widely (run 2's P1 above).
- Four P2s from the reviews of the reviewer's own MRs are open on `main` and accepted as limits: step 7 says the first line is "Review of SHA:" with no exception for a note that starts "Incomplete review of"; a mention within 10 minutes of a passed pipeline waits for the automatic review, which never comes if that pipeline passed while the MR was a Draft; the requesters come from the oldest commit's author while the CI guard decides from the push that created the branch, so the two can disagree on a person's branch built on agent commits; and a P1 on lines the diff does not touch is now rated P3.
- n=5 tasks, two runs, one model.

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
- **A central value per output token (an estimate, used only for the merged
  change and the delivered fix).** Microsoft estimates a median of 0.31 Wh
  per query (IQR 0.16-0.60) for models over 200B parameters on H100 nodes,
  PUE included, with 500 input tokens and a median of 300 output tokens, and
  energy that grows about linearly with output tokens (Oviedo et al.,
  arXiv:2509.20241, v2 of 9 Jun 2026). That is about 1.03 Wh per 1,000
  output tokens. Our loop sessions average 1,040 output tokens per call, so
  about 1.07 Wh per call, inside our range. It leaves out most of the cost
  of long inputs: our calls carry about 41k input tokens each, mostly cache
  reads, and the paper says it models prefill for long contexts only in
  part, so this central leans low. Per loop it is the runner grams plus each
  session's output tokens (in
  [sustainability/agent-tokens.json](sustainability/agent-tokens.json)) ×
  (0.31 Wh / 300 tokens) × 579 g/kWh: a median of 38 g per merged change and 26 g per
  delivered fix. The loop list it needs is the ledger job's artifact
  `ledger/loops.json` (job 17443329261, kept until 24 Nov), matched to
  sessions as `loopGrams()` in `engine/src/loops.ts` does.
- **Other published methods give more per call.** Epoch AI ("How much energy
  does ChatGPT use?", Feb 2025) puts a GPT-4o query with 10k input tokens at
  about 2.5 Wh (our high end) and one with 100k at almost 40 Wh. Jegham et
  al. (arXiv:2505.09598, Table 4) estimate Claude 3.7 Sonnet at 0.95 Wh for
  100 input and 300 output tokens, 2.99 Wh for 1k and 1k, and 5.67 Wh for
  10k and 1.5k. The Microsoft paper above finds that estimates made outside
  production serving are 4-20x too high. We keep 0.24-2.5 Wh per call as
  the published range and show the central next to it, not in its place.
- **Embodied emissions**: per vCPU-hour for the runner; not included for the
  model's hardware.

CI does this on every MR and on `main` (job `autonomy:sci`): it rebuilds the
manifest from the sessions and fails if the committed one differs, runs
`if-run` on it and fails if any review's carbon differs from `engine/src/sci.ts`,
and the MR widget shows the review figures against `main` (metrics report).
Since !249 the CI footprint in the widget comes from `autonomy:sci:pipeline`,
one pipeline against one pipeline with its job count ("Every MR measures
itself"), and the page is on Pages at
[/sci/](https://showcase-ce2cdc.gitlab.io/sci/).

Recompute it yourself, no token needed: every review's inputs and every step
of the arithmetic are in an [Impact Framework](https://if.greensoftware.foundation/)
manifest, [sustainability/agent-reviews.yml](sustainability/agent-reviews.yml)
(builtin Multiply and Sum only):

    npx -y -p @grnsft/if@1.1.1 if-run -m sustainability/agent-reviews.yml

`if-run` sums each tier's reviews, with every model call counted: for the high tier
it prints carbon-low 2182.3 and carbon-high 17845.5 g, which over 401 reviews is the
5.4-44.5 g per review above (medium: 425.7 and 3487.6 g over 112; low: 74.2 and
605.5 g over 66). It calls `lsb_release`, so a minimal container needs that
installed, and `npm list` in its working directory, so run it after `npm ci` or
from another folder. To rebuild the manifest from the committed sessions (no
token): `node engine/src/cli/review-manifest.ts`. A test fails if the committed
manifest and `sustainability/agent-tokens.json` drift apart.

## The warm verify instance (judging window)

Since the production promote of 20 Oct 20:32 UTC and until the winners are
announced (the estimate below runs to 16 Nov), one instance of the verify
service is kept warm (`MIN_INSTANCES=1` in `service/deploy/cloudrun.conf`;
`gcloud run services describe` showed minimum instances 1 on 21 Oct 12:35 UTC),
so a judge's first verify doesn't wait for a cold start (23.6 s, measured on
20 Oct): five `/health` requests took 0.28-0.31 s (median 0.29 s) on 21 Oct
12:35 UTC. It is one 2 vCPU / 2 GiB instance on
the revision that serves traffic, idle most of the time; tagged candidate
revisions get none. It goes back to 0 after judging.

These are estimates, not measurements, by the same method as the runner above:
Cloud Carbon Footprint's GCP coefficients (0.71 W per vCPU at idle, 4.26 W at
full load, 0.000392 kWh per GB-hour of memory), PUE 1.1, us-east1's grid at
579 gCO2e/kWh, and 1.2 g per vCPU-hour embodied. The low end takes the CPU at
idle; the high end at the 50% utilisation we assume for a CI job, a ceiling for
an instance that mostly waits (Cloud Run throttles its CPU between requests).
Requests from judges come on top and are not in these figures.

| Warm instance | Energy | Operational gCO2e | Embodied gCO2e | Total gCO2e |
|---|---|---|---|---|
| per day | 60-153 Wh | 35-89 | 58 | 92-146 |
| 20 Oct to 16 Nov (27 days, from the 20 Oct promote) | 1.6-4.1 kWh | 930-2,400 | 1,560 | 2,500-4,000 |

A day of the warm instance is about the grams of 4 to 18 high-risk reviews
(table above, low end against low end and high against high). When Google
Cloud's Carbon Footprint report has the project's figure for these months, it
replaces this estimate here.

Cost, from the [Cloud Run pricing page](https://cloud.google.com/run/pricing)
(read 20 Oct 2026; request-based billing, Tier 1 regions, us-east1 among them):
an idle minimum instance is billed $0.0000025 per vCPU-second and $0.0000025
per GiB-second, so 2 vCPU and 2 GiB come to $0.86 a day, about $23 for the 27
days, before the free tier (180,000 vCPU-seconds and 360,000 GiB-seconds a
month, shared with the service's real requests). It is paid from the project's
Google Cloud free trial credit.

**Region.** The service runs in us-east1. Google's
[region carbon page](https://cloud.google.com/sustainability/region-carbon)
and its [2025 data file](https://github.com/GoogleCloudPlatform/region-carbon-info/blob/main/data/yearly/2025.csv)
(both read 24 Oct 2026, 2025 data) give us-east1 31% carbon-free energy (CFE)
and 579 gCO2e/kWh. Google marks a region Low CO2 when its CFE is 75% or more,
so us-central1 (88%) and us-west1 (83%) are marked. But SCI counts the grid
intensity, not the CFE share, and on that us-central1 is 432 gCO2e/kWh, only
25% below us-east1. us-west1 is 98 g, and Montréal (northamerica-northeast1)
is 11 g, the lowest of Google's regions.

The same warm instance per day in each region (60-153 Wh a day and 58 g
embodied, from the table above; the embodied part does not change with the
region):

| Region                             | gCO2e/kWh (2025) | Operational gCO2e per day | Total gCO2e per day | Saved per day against us-east1 |
| ---------------------------------- | ---------------- | ------------------------- | ------------------- | ------------------------------ |
| us-east1 (now)                     | 579              | 35-89                     | 92-146              | -                              |
| us-central1                        | 432              | 26-66                     | 84-124              | 9-23                           |
| us-west1                           | 98               | 6-15                      | 64-73               | 29-74                          |
| northamerica-northeast1 (Montréal) | 11               | 1-2                       | 58-59               | 34-87                          |

A move to Montréal would save 34-87 g a day, about the grams of 2 to 7
high-risk reviews (low end against low end, high against high). We do not
move during judging: a Cloud Run URL carries its region (the `-ue` in
`polyman-verify-ncvkutguda-ue.a.run.app` is us-east1), and that URL is in
README.md, JUDGES.md and our submission. The service's isolated network
(`verify-isolated`) and its image repository are regional too. So the move
is planned after judging, together with a URL that does not depend on the
region. By then the warm instance is back to 0, so the move saves on the
real requests, not on the numbers in this table. Until then the warm instance's grams above are counted at us-east1's
579 g.

## What's not here yet

- A same-task test of tiering: the same MRs reviewed with tiering off (all high)
  and on. The tier table compares different MRs at different tiers.
