# engine

The scripts behind polyman's Assisted delivery: the Duo agents propose, each
step waits for a person's go-ahead (never the requester's), and CI judges and
guards every merge request.

## CI jobs (no agents)

- `autonomy:assess` scores each MR for risk (0-100) using `.autonomy.yml`:
  which paths changed, changes to the pipeline or policy, dependencies, size,
  missing tests, scanner findings and past incidents. The score goes in the
  pipeline name (for example `risk high 72/100 - critical path touched`) and
  the full breakdown in the job log. It decides how much review a change gets,
  not whether it needs approval: everything does.
- `autonomy:guard` fails the pipeline if a commit by a Duo agent touches the
  pipeline, the policy, the agent files or this folder. Those always go to a
  person.
- `autonomy:goahead` (Assisted) fails the pipeline if an agent pushed to the
  MR's branch without a person's go-ahead for that push: a comment with a
  line like `@agent go-ahead` (the mention and the word on one line), after
  the agent's latest proposal and its previous push anywhere in the project,
  and before the push. One go-ahead covers one push, and editing the proposal
  afterwards cancels it. It never counts whoever asked for the work (the MR's
  or the issue's author), an agent, GitLabDuo or anyone outside
  `go_ahead.people`, and for high risk and
  rollbacks only `go_ahead.maintainers` in `.autonomy.yml`. Who pushed which
  commit comes from the project's push events, which GitLab writes, not from
  commit emails, dates or trailers, which the agent writes; a commit no push
  accounts for fails the job, and so does an agent push that changes a
  governance path or contains a merge commit. Anyone outside
  `go_ahead.people` counts as an agent. The tier comes from `autonomy:assess`, not from a label. A
  branch an agent pushed before the MR existed needs the go-ahead on the
  issue GitLab says the MR closes.
- `autonomy:goahead:branch` applies the same rules to a push to a branch with
  no open MR, which gets a branch pipeline instead of an MR pipeline (#64). The
  go-ahead has to be on the issue the branch is named after (`<iid>-...`),
  and with no risk score the push is judged as high risk, so only
  `go_ahead.maintainers` count. A push an MR's own guard judged (made while an
  MR from the branch was open, or before one opened) is left to it. Like
  `autonomy:goahead`, it runs the guard and reads the policy from the default
  branch's head.
- `autonomy:ledger` (on `main`, and on MRs that change the engine or the
  pipeline) rebuilds the go-ahead ledger from the GitLab API: one record per
  agent push `autonomy:goahead` judged on a merged MR since the guard reached
  `main`, judged again by the guard's own check (`src/goahead-mr.ts`) with the
  policy of the target branch at the merge and the tier of the MR's last
  pipeline. A record names the proposal and go-ahead notes, who gave the
  go-ahead, who asked for the work (and checks that they differ), the risk
  tier and who it allows, the commits and the guard job's result, and carries
  the SHA-256 of the record before it. The job fails if the ledger published
  on Pages isn't the start of the rebuilt one, so an edited or deleted
  go-ahead, an edited proposal or a rewritten push shows up; the `pages` job
  then doesn't run and the published ledger stays. A change to the guard's
  rules that judges past pushes differently bumps `LEDGER_RULES` in
  `src/ledger.ts`, which starts a new chain naming the old one's head. Pages:
  `/ledger/` (table and counters) and `/ledger/ledger.json`.
- `autonomy:session-audit` (on the scheduled pipeline) checks what the agents
  did with no model in it: it reads every Duo session GitLab recorded in the
  last 25 hours (the session list, each session's `trace.jsonl`, and its
  checkpoint, which has the calls of the specialists a lead delegates to;
  the trace has only the lead's), finds every push an agent made, and holds
  each against the ledger on Pages, or for a push the ledger doesn't have yet,
  against the line `autonomy:goahead` wrote for that push in its job log. An
  agent push neither accepted fails the job (`session-audit.md` and `.json`
  are its artifacts). Failed and stopped sessions are counted, and the write
  privileges GitLab pre-approved for each session are listed, for
  information. It needs `AUDIT_TOKEN` (a masked `read_api` token of a
  Developer); without it the job says so and passes. A token GitLab doesn't
  take, or a session it can't read in full, ends it with exit 2 (allowed to
  fail). Locally:
  `AUDIT_TOKEN=... node engine/src/cli/session-audit.ts <project> --since 48h --ledger <url or file>`.
  What it can't see: it reads pushes from the shell commands an agent ran, so
  a push in a form it doesn't parse (a script file, `$G push` after `G=git`,
  `base64 -d | sh`, shells nested more than four deep) is found only if git
  prints its ref lines; a command it knows hides a push is reported unjudged.
  It is a check after the fact against an agent that slips, not a sandbox
  against one that hides on purpose: the guard on the MR is what stops pushes.
- `autonomy:flows` checks the flow files in `.gitlab/duo/flows` the way GitLab
  does when they're saved (schema, prompt safety rules, inputs).
- `autonomy:engine` runs this folder's type check and tests when it changes.
- `autonomy:republish` warns when an MR changes a value the flows are filled
  in with (`go_ahead.people`, the maintainers, the checks...) or a flow file:
  GitLab keeps running the published flows until someone runs
  `node engine/src/cli/sync-flows.ts` from the default branch. It warns again
  on the default branch after the merge, and `doctor.ts` fails until then.

The jobs use `CI_JOB_TOKEN` only (the session audit reads with `AUDIT_TOKEN`)
and never write to merge requests.

## Duo flows

The four flows are in `.gitlab/duo/flows/`, and the environment they run in is
`.gitlab/duo/agent-config.yml`. Each runs under its own service account.

They are **Assisted**: each one proposes, waits for a person's go-ahead, and
then acts one step. A go-ahead is a comment that mentions the flow and says
`go-ahead`, posted after its latest proposal by a person who is not an agent
and not the requester (the issue's or MR's author); for high and critical risk,
governance paths and rollbacks, only a maintainer's counts (`go_ahead.maintainers`). No flow starts
another flow. Every agent commit ends with a `Go-ahead:` trailer naming the
note that allowed it.

- **mr-reviewer** (an MR's first green pipeline, or mentioned): reads the risk tier from the
  pipeline name. Low risk: it adds GitLabDuo as a reviewer (GitLab's own Code
  Review; a flow can't start it with start_flow) and does a light pass itself;
  medium and high get the code, test and (high) security reviewers, who rate
  findings P1/P2/P3 with evidence without changing anything. Its note proposes
  the fixes for P1 and P2; on a go-ahead the specialists apply exactly those,
  one round, and once the new head's pipeline passes a person mentions the
  reviewer for the next review, up to 4 rounds. Any later head is reviewed only
  when a person mentions it. The note's short top says ready or not, what needs a person, the
  proposed fixes and who may give the go-ahead, and what to watch after
  release, with the evidence folded into a details block below it.
- **pipeline-fixer** (pipeline failed, or mentioned): finds the cause and
  proposes the fix; on a go-ahead it pushes exactly that fix.
- **issue-builder** (assigned or mentioned on an issue): proposes the change,
  the test and the expected risk tier; on a go-ahead it implements it and opens
  the MR.
- **incident-responder** (production check failed, or mentioned): opens a
  GitLab Incident with a severity and a timeline (detected, proposal, go-ahead,
  rollback MR, fix merged, verified) and proposes the rollback; on the maintainer's go-ahead it prepares
  the rollback MR and records the lesson in `.autonomy/incidents.json`. A real
  fix starts by assigning the incident to issue-builder.

What differs per project (how to run the checks, what the project is, what
security should focus on, account names, flow IDs) is not in the flow files:
they hold `@@markers@@` that `sync-flows` fills from `.autonomy.yml` and the
AI Catalog when it publishes them.

### Turning them on

Needs a role that can manage AI Catalog items (our Developer+ role can).

Do this only after `main` is protected (no one can push to it directly) and
"Pipelines must succeed" is on (#14). The flows have `run_git_command`, and
until then only a prompt line stops an agent from pushing straight to `main`.

1. With `GITLAB_TOKEN` set to a token with the `api` scope:
   `node engine/src/cli/setup-flows.ts --dry-run`, then without `--dry-run`.
   It creates the four flows in the order they hand work to each other
   (mr-reviewer, pipeline-fixer, issue-builder, incident-responder), enables
   them, and sets each trigger to fire only for what the flow is for:

   | Flow | Fires on |
   |---|---|
   | mr-reviewer | a passed merge request pipeline, a mention |
   | pipeline-fixer | a failed merge request pipeline, a mention |
   | issue-builder | being assigned or mentioned on an issue |
   | incident-responder | a failed pipeline on the default branch |

   Without those conditions the reviewer wakes for every pipeline in the
   project and spends credits finding out it has nothing to do (in the
   sandbox, about half of all sessions). It refuses to run until the #14
   settings are in place (`--unprotected` skips that check, for a test project
   or when a person decides to go ahead before #14), and is safe to run again:
   existing flows are kept, a flow created but never enabled is found and
   enabled, and only triggers that differ are changed.
2. It writes the service account names GitLab created into `agents` in
   `.autonomy.yml`. Commit that in an MR.
3. After it merges, `node engine/src/cli/sync-flows.ts` publishes the flows with
   those names filled in.
4. `node engine/src/cli/doctor.ts` until it says ready.

The release jobs (`ci/autonomy-release.gitlab-ci.yml`: release evidence,
production checks, rollback, carbon per change) come with the release work
(#15, #19).

`ci/autonomy-sci.gitlab-ci.yml` (job `autonomy:sci`) shows the agents' carbon
on every MR and on the default branch: it checks the committed Impact Framework
manifest against its data, reruns it with `if-run` and compares every review
with `src/sci.ts`, and measures CI's own runner time. The figures go to the MR
widget as a metrics report and to Pages at `/sci/`
(`node engine/src/cli/sci-report.ts` writes them, no token needed).

## Running it locally

Needs Node 22.18 or newer (the scripts are TypeScript run directly by Node).

```sh
npm ci --prefix engine
npm test --prefix engine
node engine/src/cli/assess.ts origin/main    # score your branch
```

Tools for maintainers, run with your own token (`GITLAB_TOKEN`):

- `node engine/src/cli/sync-flows.ts [project path]` publishes the flow files to
  the AI Catalog (`--dry-run`, `--print NAME`)
- `node engine/src/cli/doctor.ts [project path]` checks the project's setup
- `node engine/src/cli/agent-footprint.ts` measures what the agent sessions cost
