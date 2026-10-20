#!/bin/sh
# The documented API call, made as the public host: upload the even-sum sample
# with curl -F and no Origin header, and require it to be taken and run to the
# end. Used by service:golden and by the nightly incident rehearsal
# (service/ci/rehearsals), so both run the same check.
#
# Incident #65: !127 refused every upload that came by the public *.run.app
# name with no Origin header, which is how scripts, the curl call in
# public/docs.html and the production check send them. Every check before the
# merge passed, because none of them used that name.
#
# Usage: public-upload.sh BASE_URL PUBLIC_HOST
# Writes upload.zip and upload.ndjson in the current directory. Exits 1 with
# "HTTP <code> (#65)" on stderr when the upload is not taken.
set -eu
base=$1
host=$2
root=$(cd "$(dirname "$0")/../.." && pwd)

node --disable-warning=ExperimentalWarning --input-type=module -e "import { zipFolder } from '$root/service/scripts/golden.ts'; process.stdout.write(zipFolder('$root/service/samples/even-sum', 'even-sum'))" > upload.zip
code=$(curl -sS -o upload.ndjson -w '%{http_code}' -H "Host: $host" -F problem=@upload.zip "$base/api/verify")
if [ "$code" != 200 ] || ! tail -n 1 upload.ndjson | grep -q '"type":"done"'; then
  echo "curl -F problem=@even-sum.zip as $host, with no Origin: HTTP $code (#65)" >&2
  cat upload.ndjson >&2; echo >&2
  exit 1
fi
echo "ok   upload as $host with no Origin (#65)"
