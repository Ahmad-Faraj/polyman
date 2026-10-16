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

`report` is exactly what `polyman verify --json` prints. `readiness` is the
list of contest guideline checks (statement, at least ten tests, checker and
validator, correct C++ and Java solutions plus a wrong one, tags, tutorial),
taken from Mazen's Polygon contest checker.

```sh
curl -F problem=@my-problem.zip https://SERVICE_URL/api/verify
```

## What keeps it safe

It runs code anyone can upload, so:

- **The upload:** 20 MB at most; unpacked with no way out of its folder (no
  `..`, absolute paths or symlinks), at most 2000 files and 100 MB, counted as
  they are written so a zip bomb stops at the limit.
- **The config:** every path in `Config.json` must stay in the problem folder,
  and a standard checker must be a plain name (otherwise it could name any
  program on the machine). Refused uploads get a 400 that says what was wrong.
- **The run:** uploaded code runs as `runner`, a user of its own; the service
  runs as root only to hand it the upload and start polyman as that user. So
  the code can't signal, inspect or read the service (tested: `kill` and
  reading `/proc/<service>/environ` get EPERM). polyman gets none of the
  service's environment variables and 120 s per problem; when a run ends,
  however it ends, every `runner` process is killed. One verification at a
  time per instance, cancelled if the visitor leaves.
- **On Cloud Run:** a service account with no roles, all egress into a VPC with
  no route out (no NAT, egress denied), one request per instance, gVisor (gen1),
  2 vCPU and 2 GiB. Nothing is stored: the upload is deleted when the response
  ends.
- **Known limits:** DNS lookups go through Cloud Run's metadata server, which
  the VPC firewall doesn't cover, so a solution could leak what it can read
  (only its own upload) through DNS queries. Files a run leaves in `/tmp`
  stay until the instance is replaced.

## Running it

```sh
npm ci && npm run build                 # polyman, at the repository root
cd service && npm ci
POLYMAN_CLI=../dist/cli.js TESTLIB_H=/path/to/testlib.h npm run dev   # http://localhost:8080
npm test                                # 57 tests, with a stand-in for polyman
```

Or the way it runs in production, with no network at all:

```sh
docker build -f service/Dockerfile -t polyman-verify .
docker run -d --name verify --network none polyman-verify
docker exec verify curl -s -X POST localhost:8080/api/samples/even-sum/verify
```

`node service/scripts/golden.ts URL` runs every sample against a running
service and fails if one doesn't give its expected result.

## CI and Cloud Run

`ci/service.gitlab-ci.yml`, on merge requests and the default branch when the
service or polyman changes:

1. `service:test`: type check and tests.
2. `service:image`: builds the image and pushes it to this project's registry.
3. `service:golden`: runs that image in the job and checks the samples.

With Google Cloud set up (below), the default branch also releases it:

4. `service:deploy:candidate` deploys a revision with no traffic, tagged
   `c-SHA`, and `service:check:candidate` runs the samples on its own URL,
   before any visitor reaches it.
5. `service:promote:production` moves all traffic to it, and
   `service:check:production` runs the samples again on the public URL.
6. If production gets them wrong, `service:rollback:production` moves traffic
   back to the revision that served before.

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

# trust GitLab's OIDC tokens only from this project, and only on protected
# branches: a pipeline on any other branch can't get these credentials
gcloud iam workload-identity-pools create gitlab --location=global
gcloud iam workload-identity-pools providers create-oidc gitlab-com \
  --location=global --workload-identity-pool=gitlab \
  --issuer-uri=https://gitlab.com --allowed-audiences=https://gitlab.com \
  --attribute-mapping="google.subject=assertion.sub,attribute.project_path=assertion.project_path" \
  --attribute-condition="assertion.project_path=='$GITLAB_PROJECT' && assertion.ref_protected=='true'"
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
