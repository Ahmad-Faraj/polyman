# engine

The scripts behind polyman's supervised delivery: CI and the Duo agents do the
work on every merge request, and a person approves the result once.

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
  MR without a person's go-ahead for that push: a comment with a line like
  `@agent go-ahead` (the mention and the word on one line), after the agent's
  latest proposal and its previous push, and before GitLab recorded the push.
  One go-ahead covers one push, and editing the proposal afterwards cancels
  it. It never counts whoever asked for the work (the MR's or the issue's
  author), an agent or GitLabDuo, and for high risk and rollbacks only
  `go_ahead.maintainers` in `.autonomy.yml`. The tier comes from `autonomy:assess`, not from a label; who
  wrote what and when comes from GitLab's notes, not from commit dates or
  trailers. Commits an agent made before opening the MR need the go-ahead on
  the issue the MR closes, given to the agent that wrote them. An agent commit
  that no push note accounts for fails the job.
- `autonomy:flows` checks the flow files in `.gitlab/duo/flows` the way GitLab
  does when they're saved (schema, prompt safety rules, inputs).
- `autonomy:engine` runs this folder's type check and tests when it changes.

The jobs use `CI_JOB_TOKEN` only and never write to merge requests.

## Duo flows

The four flows are in `.gitlab/duo/flows/`, and the environment they run in is
`.gitlab/duo/agent-config.yml`. Each runs under its own service account.

- **mr-reviewer** (pipeline passed): reads the risk tier from the pipeline name.
  Low risk: it adds GitLabDuo as a reviewer (GitLab's own Code Review; a flow
  can't start it with start_flow) and does a light pass itself; medium and high get the code,
  test and (high) security reviewers, who rate findings P1/P2/P3 with
  evidence, fix P1 and P2 with tests and re-check until a full round finds
  none. It ends with one note for the approver ("For the approver", what was
  fixed, what to watch after release).
- **pipeline-fixer** (pipeline failed): finds the cause, fixes it, waits for its
  pipeline and hands the MR to the reviewer with `start_flow` (GitLab doesn't
  start flows from commits agents push).
- **issue-builder** (assigned or mentioned on an issue): plans, implements with
  tests and opens the MR.
- **incident-responder** (production check failed): opens an incident, prepares
  a rollback MR, records the lesson in `.autonomy/incidents.json` and asks
  issue-builder for a fix when the cause is in the code.

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
