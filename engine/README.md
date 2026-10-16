# engine

The scripts behind polyman's supervised delivery: CI and the Duo agents do the
work on every merge request, and a person approves the result once.

This MR adds the first part, which runs no agents:

- `autonomy:assess` scores each MR for risk (0-100) using `.autonomy.yml`:
  which paths changed, changes to the pipeline or policy, dependencies, size,
  missing tests, scanner findings and past incidents. The score goes in the
  pipeline name (for example `risk high 72/100 - critical path touched`) and
  the full breakdown in the job log. It decides how much review a change gets,
  not whether it needs approval: everything does.
- `autonomy:guard` fails the pipeline if a commit by a Duo agent touches the
  pipeline, the policy, the agent files or this folder. Those always go to a
  person.
- `autonomy:flows` checks the flow files in `.gitlab/duo/flows` the way GitLab
  does when they're saved (schema, prompt safety rules, inputs).
- `autonomy:engine` runs this folder's type check and tests when it changes.

The jobs use `CI_JOB_TOKEN` only and never write to merge requests.

Later parts: the Duo flows (reviewer, pipeline fixer, issue builder, incident
responder), and the release jobs in `ci/autonomy-release.gitlab-ci.yml`
(release evidence, production checks, rollback, carbon per change).

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
