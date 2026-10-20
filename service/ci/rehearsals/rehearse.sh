#!/usr/bin/env bash
# Nightly incident rehearsal: for every past incident caused by a code change,
# re-plant its bug in a throwaway copy of this commit and require the checks
# that run before a merge to refuse it. Nothing is pushed or deployed.
#
# Each incident is a folder here (65/, ...) with:
#   bug.patch     the change that caused it, as merged
#   incident.env  INCIDENT, SOURCE, TEST_FILE (the service:test file that must
#                 fail), GOLDEN_STATUS (the HTTP status the golden public-host
#                 upload must get)
#
# Per incident:
#   1. control: TEST_FILE passes on the copy as it is (else the failures below
#      would prove nothing)
#   2. the patch still applies (else the code moved: refresh the patch)
#   3. with the bug in, TEST_FILE has failing tests (service:test refuses it)
#   4. with the bug in, the service started from source gets the golden
#      public-host upload (service/ci/public-upload.sh) refused with
#      GOLDEN_STATUS. The refusal happens before polyman runs, so a stand-in
#      polyman is enough; any other answer counts as not refused.
# Exits 0 only when every incident was re-planted and refused by both checks.
#
# Run from the repository root after `npm ci` in service/. Writes
# rehearsal/report.txt and rehearsal/junit.xml.
set -u

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
out=${REHEARSAL_OUT:-$root/rehearsal}
public_host=${PUBLIC_HOST:-polyman-verify-1.us-east1.run.app}
mkdir -p "$out"
report=$out/report.txt
: > "$report"
cases=()
failures=0
work=$(mktemp -d)
copies=()
server=
cleanup() {
  [ -z "$server" ] || kill "$server" 2>/dev/null
  for c in "${copies[@]}"; do git -C "$root" worktree remove --force "$c" >/dev/null 2>&1; done
  rm -rf "$work"
}
trap cleanup EXIT

xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g'; }
# record NAME OK MESSAGE: one JUnit test case
record() {
  local body=""
  [ "$2" = ok ] || { body="<failure message=\"$(printf '%s' "$3" | xml)\"/>"; failures=$((failures + 1)); }
  cases+=("<testcase classname=\"rehearsal\" name=\"$(printf '%s' "$1" | xml)\">$body<system-out>$(printf '%s' "$3" | xml)</system-out></testcase>")
}
say() { echo "$1" | tee -a "$report"; }

# failed-test count of a vitest json report
failed_tests() { node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(r.numFailedTests)' "$1"; }

rehearse() {
  local dir=$1 INCIDENT='' SOURCE='' TEST_FILE='' GOLDEN_STATUS=''
  # shellcheck disable=SC1091
  . "$dir/incident.env"
  local id="#$INCIDENT" copy="$work/$INCIDENT" log="$out/$INCIDENT"
  mkdir -p "$log"
  echo "== $id: $SOURCE"

  git -C "$root" worktree add --detach --quiet "$copy" HEAD || { say "$id: could not make a working copy"; record "$id re-planted" fail "no working copy"; return; }
  copies+=("$copy")
  ln -s "$root/service/node_modules" "$copy/service/node_modules"

  # 1. control
  if ! (cd "$copy/service" && npx vitest run "$TEST_FILE" > "$log/control.txt" 2>&1); then
    say "$id: NOT REHEARSED: $TEST_FILE fails without the bug (see $INCIDENT/control.txt), so its failures with the bug would prove nothing"
    say "NEXT STEP: a maintainer fixes $TEST_FILE on main; the rehearsal then runs again next night."
    record "$id control" fail "$TEST_FILE fails without the bug"
    return
  fi
  record "$id control" ok "$TEST_FILE passes without the bug"

  # 2. the patch applies
  if ! git -C "$copy" apply "$dir/bug.patch" 2> "$log/apply.txt"; then
    say "$id: NOT REHEARSED: the code moved; refresh the rehearsal patch ($(realpath --relative-to="$root" "$dir/bug.patch")): $(head -n 3 "$log/apply.txt" | tr '\n' ' ')"
    say "NEXT STEP: a maintainer re-creates the bug of $id ($SOURCE) on today's main, saves it as that bug.patch, checks this job fails both checks with it, and merges the refresh."
    record "$id re-planted" fail "the patch no longer applies: the code moved; refresh the rehearsal patch"
    return
  fi
  record "$id re-planted" ok "$(realpath --relative-to="$root" "$dir/bug.patch") applied"

  # 3. service:test
  local tests_msg tests_ok=fail failed
  (cd "$copy/service" && npx vitest run "$TEST_FILE" --reporter=default --reporter=json --outputFile.json="$log/test.json" > "$log/test.txt" 2>&1)
  failed=$(failed_tests "$log/test.json" 2>/dev/null || echo "")
  if [ -n "$failed" ] && [ "$failed" -gt 0 ]; then
    tests_ok=ok; tests_msg="service:test ($failed failed)"
  else
    tests_msg="service:test passed it (${failed:-no report} failed)"
  fi
  record "$id refused by service:test" "$tests_ok" "$tests_msg: $TEST_FILE"

  # 4. golden public-host upload, against the service started from the copy
  local stub="$work/polyman/dist/cli.js" port=$((18000 + INCIDENT)) golden_ok=fail golden_msg
  mkdir -p "$(dirname "$stub")"; : > "$stub"
  (cd "$copy/service" && PORT=$port SKIP_WARM_UP=1 ALLOW_RUN_AS_SELF=1 POLYMAN_CLI="$stub" TESTLIB_H="$stub" LOG_LEVEL=warn \
    exec node --disable-warning=ExperimentalWarning src/server.ts > "$log/service.txt" 2>&1) &
  server=$!
  for _ in $(seq 1 30); do curl -sf "http://127.0.0.1:$port/health" > /dev/null && break; sleep 1; done
  if ! curl -sf "http://127.0.0.1:$port/health" > /dev/null; then
    golden_msg="golden not run: the service never became healthy (see $INCIDENT/service.txt)"
  else
    (cd "$log" && sh "$copy/service/ci/public-upload.sh" "http://127.0.0.1:$port" "$public_host") > "$log/golden.txt" 2>&1
    local status=$?
    local line; line=$(grep -m1 -o 'HTTP [0-9]*\|ok   upload.*' "$log/golden.txt")
    if [ "$status" != 0 ] && grep -q "HTTP $GOLDEN_STATUS (" "$log/golden.txt"; then
      golden_ok=ok; golden_msg="golden (HTTP $GOLDEN_STATUS)"
    elif [ "$status" = 0 ]; then
      golden_msg="golden took the upload: ${line:-passed}"
    else
      golden_msg="golden failed, but not with HTTP $GOLDEN_STATUS: ${line:-see $INCIDENT/golden.txt}"
    fi
  fi
  kill "$server" 2>/dev/null; wait "$server" 2>/dev/null; server=
  record "$id refused by golden" "$golden_ok" "$golden_msg, upload as $public_host with no Origin"

  if [ "$tests_ok" = ok ] && [ "$golden_ok" = ok ]; then
    say "$id: re-planted, refused by $tests_msg and $golden_msg"
  else
    say "$id: re-planted, NOT refused: $tests_msg; $golden_msg"
    say "NEXT STEP: a maintainer opens an issue: the checks that caught $id ($SOURCE) no longer refuse its bug; this job's rehearsal/$INCIDENT/ has the logs."
  fi
}

found=0
for entry in "$here"/*/incident.env; do
  [ -e "$entry" ] || continue
  found=$((found + 1))
  rehearse "$(dirname "$entry")"
done
if [ "$found" = 0 ]; then
  say "no incident to rehearse in $here"
  record "registry" fail "no incident.env found"
fi

{
  echo '<?xml version="1.0" encoding="UTF-8"?>'
  echo "<testsuites><testsuite name=\"incident rehearsal\" tests=\"${#cases[@]}\" failures=\"$failures\">"
  printf '%s\n' "${cases[@]}"
  echo '</testsuite></testsuites>'
} > "$out/junit.xml"

[ "$failures" = 0 ]
