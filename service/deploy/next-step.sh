#!/bin/sh
# Says what a person does next once the candidate passed its check (the end of
# service:check:candidate): which promote job to click, or not to click it
# because a newer main pipeline has a newer candidate. The same newest-release
# rule as `cloudrun.sh promote`, so the advice matches what the promote does.
# It only reads (the repository, and the pipeline's jobs through the API) and
# never fails the job: a lookup that doesn't work is said, not hidden.
#
# Needs: CI_COMMIT_SHA, CI_DEFAULT_BRANCH, CI_REPOSITORY_URL, CI_PIPELINE_URL,
# CI_PROJECT_URL, CI_API_V4_URL, CI_PROJECT_ID, CI_PIPELINE_ID, CI_JOB_TOKEN.
PROMOTE_JOB=service:promote:production
SERVICE_PATHS=$(sed -n 's/^SERVICE_PATHS="\(.*\)"$/\1/p' "$(dirname "$0")/cloudrun.conf")

say() { echo "NEXT STEP: $1"; }

# the promote job of this pipeline, as a link; the job token's reads fall back
# to the public API, as the production check does
promote_url() {
  api="$CI_API_V4_URL/projects/$CI_PROJECT_ID/pipelines/$CI_PIPELINE_ID/jobs?per_page=100"
  jobs=$(curl -sSf -H "JOB-TOKEN: $CI_JOB_TOKEN" "$api" 2>/dev/null || curl -sSf "$api" 2>/dev/null) || return 1
  id=$(printf '%s' "$jobs" | PROMOTE_JOB="$PROMOTE_JOB" node -e '
    const jobs = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const job = jobs.find((j) => j.name === process.env.PROMOTE_JOB);
    if (job) console.log(job.id);' 2>/dev/null) || return 1
  [ -n "$id" ] && echo "$CI_PROJECT_URL/-/jobs/$id"
}

HEAD=
if git fetch --quiet --depth=1 "$CI_REPOSITORY_URL" "refs/heads/$CI_DEFAULT_BRANCH" 2>/dev/null; then
  HEAD=$(git rev-parse FETCH_HEAD 2>/dev/null)
fi

if [ -n "$HEAD" ] && [ "$HEAD" != "$CI_COMMIT_SHA" ] && [ -z "$SERVICE_PATHS" ]; then
  # an empty path list would make git diff compare the whole tree
  say "could not read SERVICE_PATHS from cloudrun.conf, so it is not known whether $CI_DEFAULT_BRANCH ($HEAD) changed the service again. The promote job checks again and refuses if this is not the newest release."
elif [ -n "$HEAD" ] && [ "$HEAD" != "$CI_COMMIT_SHA" ]; then
  CHANGED=0
  # shellcheck disable=SC2086 # one path per word
  git diff --quiet "$CI_COMMIT_SHA" "$HEAD" -- $SERVICE_PATHS 2>/dev/null || CHANGED=$?
  if [ "$CHANGED" = 1 ]; then
    say "a newer main pipeline exists: don't promote this one. $CI_DEFAULT_BRANCH is at $HEAD, which changed the service again; promote the candidate of that commit's pipeline once its check passes."
    exit 0
  elif [ "$CHANGED" != 0 ]; then
    say "could not compare this commit with $CI_DEFAULT_BRANCH ($HEAD). The promote job checks again and refuses if this is not the newest release."
  fi
elif [ -z "$HEAD" ]; then
  say "could not read the head of $CI_DEFAULT_BRANCH, so it is not known whether a newer pipeline exists. The promote job checks again and refuses if this is not the newest release."
fi

if URL=$(promote_url); then
  say "the candidate passed its check. To release it, a person who has read this log runs $PROMOTE_JOB: $URL"
else
  say "the candidate passed its check. To release it, a person who has read this log runs $PROMOTE_JOB in this pipeline: $CI_PIPELINE_URL (the job link could not be looked up)"
fi
