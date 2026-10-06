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
# The name is validated first: it is echoed into weed shell's stdin, where a
# newline would start a second command (architect review 2026-10-06).
set -u

bucket="${BRICX_S3_BUCKET:?BRICX_S3_BUCKET is not set}"

# S3 bucket naming, as ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ (POSIX case
# patterns, no new dependency): 3-63 characters of a-z, 0-9, '.' and '-',
# starting and ending with a letter or digit.
valid_bucket_name() {
  case "$1" in
    *[!a-z0-9.-]* | [!a-z0-9]* | *[!a-z0-9]) return 1 ;;
  esac
  [ "${#1}" -ge 3 ] && [ "${#1}" -le 63 ]
}
if ! valid_bucket_name "${bucket}"; then
  echo "s3-init FAILED: BRICX_S3_BUCKET is not a valid S3 bucket name (3-63 characters: a-z, 0-9, '.' and '-', starting and ending with a letter or digit). Check S3_BUCKET in .env." >&2
  exit 1
fi
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
