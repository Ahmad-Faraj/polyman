#!/bin/sh
# Deploys the verify service to Cloud Run from CI. Signs in with the job's OIDC
# token through Workload Identity Federation, so no Google key is stored.
#
#   service/deploy/cloudrun.sh candidate   new revision, no traffic, tagged c-<sha>
#   service/deploy/cloudrun.sh promote     all traffic to that revision
#   service/deploy/cloudrun.sh rollback    all traffic back to $PREVIOUS_REVISION
#
# A release is checked twice: the candidate on its own URL (public, but not
# where visitors go) before it gets traffic, and production after the switch.
# The very first deploy is the exception: creating the service gives the
# first revision all traffic at once.
#
# Needs: GCP_PROJECT_ID, GCP_WIF_PROVIDER, GCP_SERVICE_ACCOUNT, GCP_ID_TOKEN,
# CI_COMMIT_SHORT_SHA; candidate also SERVICE_IMAGE and the CI_REGISTRY_*
# variables; promote CANDIDATE_REVISION; rollback PREVIOUS_REVISION and
# CANDIDATE_REVISION (both from the deploy jobs' dotenv reports).
set -eu
MODE="${1:?usage: cloudrun.sh candidate|promote|rollback}"
. "$(dirname "$0")/cloudrun.conf"

printf '%s' "$GCP_ID_TOKEN" > .gcp-oidc-token
trap 'rm -f .gcp-oidc-token .gcp-creds.json crane.tgz' EXIT
gcloud iam workload-identity-pools create-cred-config "$GCP_WIF_PROVIDER" \
  --service-account="$GCP_SERVICE_ACCOUNT" --credential-source-file=.gcp-oidc-token \
  --output-file=.gcp-creds.json --quiet
gcloud auth login --cred-file=.gcp-creds.json --quiet
gcloud config set project "$GCP_PROJECT_ID" --quiet

AR_IMAGE="$REGION-docker.pkg.dev/$GCP_PROJECT_ID/$REPOSITORY/$SERVICE:$CI_COMMIT_SHORT_SHA"
TAG="c-$CI_COMMIT_SHORT_SHA"

describe() { gcloud run services describe "$SERVICE" --region "$REGION" --format="$1"; }

# "yes" or "no"; any error other than not-found stops the deploy
service_exists() {
  if out=$(describe 'value(metadata.name)' 2>&1); then echo yes; return; fi
  case "$out" in
    *NOT_FOUND*|*"could not be found"*|*"Cannot find service"*) echo no ;;
    *) echo "could not tell whether $SERVICE exists: $out" >&2; exit 1 ;;
  esac
}

# the revision that serves all traffic now (not just the newest one)
serving() {
  describe json | python3 -c 'import json,sys
for t in json.load(sys.stdin).get("status", {}).get("traffic", []):
    if t.get("percent") == 100 and t.get("revisionName"):
        print(t["revisionName"])'
}

copy_image() {
  # Cloud Run pulls from Artifact Registry, so copy the image this pipeline
  # built; crane is pinned to a release and checked against its checksum
  curl -sSfL -o crane.tgz "https://github.com/google/go-containerregistry/releases/download/v0.20.2/go-containerregistry_Linux_x86_64.tar.gz"
  echo "c14340087103ba9dadf61d45acd20675490fd0ccbd56ac7901fc1b502137f44b  crane.tgz" | sha256sum -c -
  tar -xzf crane.tgz crane
  ./crane auth login "$CI_REGISTRY" -u "$CI_REGISTRY_USER" -p "$CI_REGISTRY_PASSWORD"
  ./crane auth login "$REGION-docker.pkg.dev" -u oauth2accesstoken -p "$(gcloud auth print-access-token)"
  ./crane copy "${SERVICE_IMAGE:?}" "$AR_IMAGE"
}

deploy() {
  gcloud run deploy "$SERVICE" --image "$AR_IMAGE" --region "$REGION" --quiet \
    --service-account "$RUNTIME_SA" \
    --execution-environment "$EXECUTION_ENVIRONMENT" \
    --concurrency "$CONCURRENCY" --cpu "$CPU" --memory "$MEMORY" --timeout "$TIMEOUT" \
    --min-instances "$MIN_INSTANCES" --max-instances "$MAX_INSTANCES" \
    --network "$NETWORK" --subnet "$SUBNET" --vpc-egress all-traffic \
    --allow-unauthenticated \
    --set-env-vars "APP_COMMIT=$CI_COMMIT_SHORT_SHA,PROBLEM_TIMEOUT_MS=$PROBLEM_TIMEOUT_MS" \
    "$@"
}

# The commit at the head of the default branch, or empty if it can't be read.
main_head() {
  curl -sSf --header "JOB-TOKEN: $CI_JOB_TOKEN" \
    "$CI_API_V4_URL/projects/$CI_PROJECT_ID/repository/branches/$CI_DEFAULT_BRANCH" 2>/dev/null |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["commit"]["id"])' 2>/dev/null || true
}

case "$MODE" in
  candidate)
    EXISTS=$(service_exists)
    copy_image
    if [ "$EXISTS" = yes ]; then
      deploy --no-traffic --tag "$TAG"
      FIRST=false
    else
      deploy --tag "$TAG"
      FIRST=true
    fi
    BASE=$(describe 'value(status.url)')
    REVISION=$(describe 'value(status.latestCreatedRevisionName)')
    [ -n "$BASE" ] && [ -n "$REVISION" ] || { echo "the deploy finished but the service has no URL or revision" >&2; exit 1; }
    printf 'CANDIDATE_URL=%s\nCANDIDATE_REVISION=%s\nFIRST_RELEASE=%s\n' \
      "$(echo "$BASE" | sed "s#https://#https://$TAG---#")" "$REVISION" "$FIRST" > deploy.env
    ;;
  promote)
    # two pipelines close together: only the newest commit may take production
    HEAD=$(main_head)
    if [ -n "$HEAD" ] && [ "$HEAD" != "$CI_COMMIT_SHA" ]; then
      echo "not promoting: $CI_DEFAULT_BRANCH has moved on to $HEAD, whose pipeline releases it" >&2
      exit 1
    fi
    [ -n "$HEAD" ] || echo "warning: could not read the head of $CI_DEFAULT_BRANCH, promoting anyway" >&2
    PREVIOUS=$(serving)
    if [ -z "$PREVIOUS" ] && [ "${FIRST_RELEASE:-false}" != true ]; then
      echo "no revision serves all traffic (a split?); refusing to switch without a revision to roll back to" >&2
      exit 1
    fi
    # written before the switch, so rollback knows where to go even if this job fails after it
    printf 'SERVICE_URL=%s\nPREVIOUS_REVISION=%s\n' "$(describe 'value(status.url)')" "$PREVIOUS" > deploy.env
    gcloud run services update-traffic "$SERVICE" --region "$REGION" --to-revisions "${CANDIDATE_REVISION:?}=100" --quiet
    ;;
  rollback)
    NOW=$(serving || true)
    if [ -n "${PREVIOUS_REVISION:-}" ] && [ "$PREVIOUS_REVISION" != "${CANDIDATE_REVISION:-}" ]; then
      gcloud run services update-traffic "$SERVICE" --region "$REGION" --to-revisions "$PREVIOUS_REVISION=100" --quiet
      echo "traffic is back on $PREVIOUS_REVISION"
    elif [ -n "$NOW" ] && [ "$NOW" = "${CANDIDATE_REVISION:-}" ]; then
      echo "production is serving $NOW, which failed its check, and there is no earlier revision to go back to; a person has to act" >&2
      exit 1
    else
      echo "nothing to roll back: the failed revision ($CANDIDATE_REVISION) never got traffic"
    fi
    ;;
  *) echo "unknown mode $MODE" >&2; exit 2 ;;
esac
