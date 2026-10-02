#!/bin/sh
# s3-init (ROADMAP P2-01b, ADR 0036): creates the dev S3 bucket on the
# SeaweedFS filer, deterministically and idempotently.
#
# SeaweedFS 4.48 `weed mini` gives each component about 6 s to start, then
# tries its own S3_BUCKET once and never retries; on a slow cold start the
# filer loses that race and the bucket is never created. This script runs
# in its own one-shot container (`pnpm dev:up` runs it before waiting for
# the stack) and retries until the filer answers, within bounds:
# - success means the bucket directory EXISTS in the filer, checked before
#   creating and again after (the shell's output is never parsed);
# - at most S3_INIT_ATTEMPTS attempts, S3_INIT_DELAY_SECONDS apart, and
#   never longer than S3_INIT_DEADLINE_SECONDS in total;
# - when the bucket still does not exist, it exits 1 with a clear message.
set -u

bucket="${BRICX_S3_BUCKET:?BRICX_S3_BUCKET is not set}"
attempts="${S3_INIT_ATTEMPTS:-60}"
delay="${S3_INIT_DELAY_SECONDS:-2}"
deadline_seconds="${S3_INIT_DEADLINE_SECONDS:-180}"
filer="s3:8888"
master="s3:9333"

# The filer answers 200 for an existing directory and 404 for a missing
# one; a filer that is not up yet fails the same way, which is "not yet".
bucket_exists() {
  wget -q -T 3 --spider "http://${filer}/buckets/${bucket}/" 2>/dev/null
}

deadline=$(($(date +%s) + deadline_seconds))
attempt=1
while :; do
  if bucket_exists; then
    echo "s3-init: bucket ${bucket} exists (attempt ${attempt})"
    exit 0
  fi
  # weed shell waits for the master without a limit, so every call is
  # bounded. Its output is shown for diagnosis only.
  echo "s3.bucket.create -name ${bucket}" |
    timeout 10 weed shell -master="${master}" -filer="${filer}" 2>&1 |
    sed 's/^/s3-init:   weed shell: /'
  if bucket_exists; then
    echo "s3-init: bucket ${bucket} created (attempt ${attempt})"
    exit 0
  fi
  echo "s3-init: attempt ${attempt}/${attempts}: bucket ${bucket} does not exist yet (filer not ready?)"
  if [ "${attempt}" -ge "${attempts}" ] || [ "$(date +%s)" -ge "${deadline}" ]; then
    echo "s3-init FAILED: bucket ${bucket} does not exist after ${attempt} attempts (limit ${attempts} attempts or ${deadline_seconds} s). See 'docker compose logs s3'." >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep "${delay}"
done
