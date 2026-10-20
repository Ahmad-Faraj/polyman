# polyman verify service

A small web service that verifies a polyman problem, or a whole contest of
them, uploaded as a zip (#19). It runs `polyman verify` from this repository,
checks the contest guidelines, and streams the result to the page as it goes.

```
service/
  src/          the API (Fastify) and the pieces it uses
  public/       the page (plain HTML, CSS and JS, no build step)
  samples/      sample problems and what each should give (the golden set)
  scripts/      golden.ts: run the samples against a URL and compare
  deploy/       Cloud Run settings and the deploy script
  ci/           the CI jobs, included from the root .gitlab-ci.yml
  Dockerfile    build from the repository root
```

## API

| Route | |
|---|---|
| `GET /` | the page |
| `GET /health` | `{"ok":true}` |
| `GET /api/version` | polyman version, service version, commit |
| `GET /api/samples` | sample problems with their expected results |
| `POST /api/verify` | multipart field `problem`: a zip with one problem (a `Config.json` at its root) or a contest (one folder per problem) |
| `POST /api/samples/NAME/verify` | the same, on a sample |

Verify answers with one JSON object per line while it works:

```json
{"type":"start","problems":["even-sum"],"polyman":"3.0.0"}
{"type":"step","problem":"even-sum","step":1,"title":"Compiling Generators"}
{"type":"problem","problem":"even-sum","ok":true,"seconds":19.3,"report":{...},"readiness":[...]}
{"type":"done","ok":true,"seconds":19.4}
```

The last line is `done`, or `{"type":"error","message":...}` if the service
itself failed. `report` is what `polyman verify --json` prints, or `null` with
an `error` when the run timed out, was cancelled or crashed. `readiness` is the
list of contest guideline checks, taken from Mazen's Polygon contest checker: a
complete statement, at least ten tests, a checker that passes its tests, a
validator, a main correct solution, correct C++ and Java solutions plus a wrong
one, tags, a tutorial. A problem is `ok` (ready) when polyman passed and no
critical check failed.

```sh
curl -F problem=@my-problem.zip https://SERVICE_URL/api/verify
```

## What keeps it safe

It runs code anyone can upload, so:

- **The upload:** 20 MB at most (413 above that), and it must arrive within two
  minutes. It is unpacked with no way out of its folder (no `..`, absolute
  paths or symlinks), at most 2000 entries, 20 MB per file and 100 MB in all,
  counted as they are written so a zip bomb stops at the limit. polyman's
  compile cache (`.polyman`) is left out, so only the sources run.
- **The config:** every path in `Config.json` must stay in the problem folder;
  names polyman turns into folders (solutions, testsets, generators, groups)
  and a standard checker must be plain names. A refused upload gets a 400 that
  says which field was wrong.
- **The run:** uploaded code runs as `runner`, a user of its own, at most 256
  processes. The service runs as root only to hand it the upload, start
  polyman as that user, and clean up after it. Everything the service does to
  an upload happens before its code runs; after that the folder is the
  code's, and the service only deletes it. The code can't signal, inspect or
  read the service (checked in the image: `kill` and reading
  `/proc/<service>/environ` get EPERM). polyman gets only `PATH`, with `HOME`
  and `TMPDIR` set to the problem folder, `LANG`, and a 60 s compile limit
  (`POLYMAN_COMPILE_TIMEOUT_MS`; polyman's default of 10 s is too tight in
  the sandbox), and 120 s per problem. Before it listens, the service verifies
  one sample to warm the compilers, so the first visitor isn't the one who
  pays for a cold start. When a run
  ends, however it ends, every `runner` process is killed (from inside the
  user, so a fork loop can't outrun it) and what it left in `/tmp`,
  `/var/tmp` and `/dev/shm` is removed. One verification at a time per
  instance, cancelled if the visitor leaves.
- **On Cloud Run:** a service account with no roles, all egress into a VPC with
  no route out (no NAT, egress denied), one request per instance, gVisor (gen1),
  2 vCPU and 2 GiB. The upload is deleted when the response ends. Through
  the judging window one instance is kept warm (`MIN_INSTANCES` in
  `deploy/cloudrun.conf`, a service-level minimum, so only the revision with
  traffic has it); its grams and cost are in SUSTAINABILITY.md.
- **Known limit:** DNS lookups go through Cloud Run's metadata server, which the
  VPC firewall doesn't cover, so a solution could leak what it can read (its
  own upload and the image's public files) through DNS queries. The same
  metadata server also gives a solution an access token for the runtime service
  account. That account has no roles, so the token can do nothing, but check
  after every deploy that it still has none
  (`gcloud projects get-iam-policy $PROJECT_ID --flatten=bindings --filter=bindings.members:verify-runtime@$PROJECT_ID.iam.gserviceaccount.com`
  must print nothing).
- **Cost:** there is no rate limit per visitor, and one upload can keep an
  instance busy for a long time. Set a budget alert on the Google Cloud project
  before the URL is public.

## Running it

Needs Node 22.18 or newer (it runs the TypeScript files directly).

```sh
npm ci && npm run build                 # polyman, at the repository root
cd service && npm ci
TESTLIB_H=/path/to/testlib.h npm run dev   # http://localhost:8080, polyman from ../dist
npm test                                # with a stand-in for polyman; the runner-user tests need root
```

Or the way it runs in production, with no network at all:

```sh
docker build -f service/Dockerfile -t polyman-verify .
docker run -d --name verify --network none polyman-verify
docker exec verify curl -s -X POST localhost:8080/api/samples/even-sum/verify
```

`node service/scripts/golden.ts URL` runs every sample against a running
service and compares each result with `samples/NAME.expected.json`. The samples:

| Sample | What it shows |
|---|---|
| `even-sum` | a complete problem; everything passes |
| `wrong-tag` | a wrong solution tagged OK; caught |
| `not-ready` | runs correctly, but four tests and no tutorial; not contest-ready |
| `sandbox-check` | a solution that is only right when it runs as root; it must stay Wrong Answer, or the sandbox is broken |

## CI and Cloud Run

`ci/service.gitlab-ci.yml`, on merge requests and the default branch when the
service or polyman changes:

1. `service:test`: type check and tests.
2. `service:image`: builds the image and pushes it to this project's registry.
3. `service:golden`: runs that image in the job and checks the samples.

With Google Cloud set up (below), the default branch also releases it:

4. `service:deploy:candidate` deploys a revision with no traffic, tagged
   `c-SHA`, and `service:check:candidate` runs the samples on its own URL
   (public, but not where visitors go). The very first deploy is the
   exception: creating the service gives that revision all traffic at once.
5. `service:promote:production` is manual: the pipeline shows as blocked
   until a person who has read the candidate's check clicks it (the go-ahead
   for production). It moves all traffic to the candidate, unless a newer
   commit on the default branch changed the service again (that newer
   pipeline has the newer candidate, so this job ends without a switch, as a
   warning rather than a deployment, and the production check checks
   nothing). A later merge that only touched docs or the corpus does not
   block it. Then `service:check:production` makes sure production serves
   this commit (`/api/version`), runs the samples again on the public URL,
   and the release monitor (`engine/src/cli/monitor.ts`) checks the routes the
   review of the merged MR said to watch against what those requests did.
6. If production serves another commit, gets the samples wrong, or a watched
   route is over its limit, `service:rollback:production` moves traffic back
   to the revision that served before, and fails loudly if there is none. If
   the monitor itself couldn't run (the MR lookup or the monitor failed), the
   check ends as a warning and the release stays; `monitor.txt` says why.

CI signs in to Google Cloud with the job's OIDC token through Workload
Identity Federation, so no Google key is stored in GitLab.

### One-time Google Cloud setup

Run with the gcloud CLI as someone who can manage the project:

```sh
PROJECT_ID=your-project-id
REGION=us-east1
GITLAB_PROJECT=gitlab-ai-hackathon/transcend-october-2026/30770856/showcase

gcloud config set project $PROJECT_ID
gcloud services enable run.googleapis.com artifactregistry.googleapis.com \
  compute.googleapis.com iamcredentials.googleapis.com sts.googleapis.com

# images
gcloud artifacts repositories create polyman --repository-format=docker --location=$REGION

# the service runs as this account, which gets no roles
gcloud iam service-accounts create verify-runtime --display-name="verify service (no permissions)"

# a network with no way out: no NAT, and egress denied
gcloud compute networks create verify-isolated --subnet-mode=custom
gcloud compute networks subnets create verify-isolated --network=verify-isolated \
  --region=$REGION --range=10.20.0.0/26
gcloud compute firewall-rules create verify-deny-egress --network=verify-isolated \
  --direction=EGRESS --action=DENY --rules=all --destination-ranges=0.0.0.0/0 --priority=100

# the identity CI deploys as
gcloud iam service-accounts create gitlab-deployer --display-name="GitLab CI deployer"
SA=gitlab-deployer@$PROJECT_ID.iam.gserviceaccount.com
for role in roles/run.admin roles/artifactregistry.writer roles/compute.networkUser; do
  gcloud projects add-iam-policy-binding $PROJECT_ID --member=serviceAccount:$SA --role=$role
done
# it may deploy the service as verify-runtime, and nothing else
gcloud iam service-accounts add-iam-policy-binding verify-runtime@$PROJECT_ID.iam.gserviceaccount.com \
  --member=serviceAccount:$SA --role=roles/iam.serviceAccountUser

# trust GitLab's OIDC tokens only from this project's protected main branch:
# a pipeline on any other branch or tag can't get these credentials
gcloud iam workload-identity-pools create gitlab --location=global
gcloud iam workload-identity-pools providers create-oidc gitlab-com \
  --location=global --workload-identity-pool=gitlab \
  --issuer-uri=https://gitlab.com --allowed-audiences=https://gitlab.com \
  --attribute-mapping="google.subject=assertion.sub,attribute.project_path=assertion.project_path" \
  --attribute-condition="assertion.project_path=='$GITLAB_PROJECT' && assertion.ref_protected=='true' && assertion.ref=='main' && assertion.ref_type=='branch'"
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
POOL=projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/gitlab
gcloud iam service-accounts add-iam-policy-binding $SA --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/$POOL/attribute.project_path/$GITLAB_PROJECT"

echo "GCP_WIF_PROVIDER=$POOL/providers/gitlab-com"
echo "GCP_SERVICE_ACCOUNT=$SA"
```

Then in Settings > CI/CD > Variables (none of these are secret):

| Key | Value |
|---|---|
| `GCP_PROJECT_ID` | the project id |
| `GCP_WIF_PROVIDER` | printed above |
| `GCP_SERVICE_ACCOUNT` | printed above |
| `GCP_REGION` | optional, `us-east1` by default |

Optional overrides, read in `deploy/cloudrun.conf`: `GCP_ARTIFACT_REPO`,
`GCP_RUNTIME_SERVICE_ACCOUNT`, `GCP_VERIFY_NETWORK`, `GCP_VERIFY_SUBNET`.
