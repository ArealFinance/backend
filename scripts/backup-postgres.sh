#!/usr/bin/env bash
#
# backup-postgres.sh — nightly encrypted pg_dump for the Areal backend.
#
# Per the Phase 12.1 architect plan §13: dump the `areal` database from the
# running postgres container, gzip + AES-256-CBC encrypt with a passphrase
# from env, upload to S3-compatible off-VPS storage, and prune local copies.
#
# Cron entry (operator-installed, see OPERATOR-RUNBOOK-PHASE-12.1.md §8):
#   0 3 * * * /opt/areal/backend/scripts/backup-postgres.sh >> /var/log/areal-backup.log 2>&1
#
# Required env (sourced from /opt/areal/backend/.env):
#   POSTGRES_DB        e.g. areal
#   POSTGRES_USER      e.g. areal
#   BACKUP_PASSPHRASE  openssl rand -hex 32 — store in pass/age, NEVER in repo
#
# Optional env (defaults below):
#   BACKUP_LOCAL_DIR        default: /var/backups/areal
#   BACKUP_LOCAL_RETAIN_DAYS default: 7
#   BACKUP_REMOTE_RETAIN_DAYS default: 90  (lifecycle policy on bucket)
#   BACKUP_S3_BUCKET        e.g. s3://areal-backups   (no trailing /)
#   BACKUP_S3_ENDPOINT      e.g. https://<account>.r2.cloudflarestorage.com
#   AWS_ACCESS_KEY_ID
#   AWS_SECRET_ACCESS_KEY
#   AREAL_BACKEND_DIR       default: /opt/areal/backend  (compose project root)
#
# Exits 0 on success, non-zero on failure. Emits a syslog line + writes a
# Prometheus textfile metric to /var/lib/node_exporter/areal_backup.prom for
# the obs stack to pick up (Phase 22 alert rule will fire on stale metric).

set -euo pipefail
umask 077

readonly BACKEND_DIR="${AREAL_BACKEND_DIR:-/opt/areal/backend}"
readonly LOCAL_DIR="${BACKUP_LOCAL_DIR:-/var/backups/areal}"
readonly LOCAL_RETAIN="${BACKUP_LOCAL_RETAIN_DAYS:-7}"
readonly TEXTFILE_DIR="/var/lib/node_exporter"
readonly TEXTFILE="$TEXTFILE_DIR/areal_backup.prom"

ts="$(date -u +%Y%m%dT%H%M%SZ)"
out_plain="$LOCAL_DIR/areal-${ts}.sql.gz"
out_enc="$LOCAL_DIR/areal-${ts}.sql.gz.enc"

log() { logger -t areal-backup "$*"; printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

emit_metric() {
  local result="$1" duration="$2" size="$3"
  mkdir -p "$TEXTFILE_DIR" 2>/dev/null || true
  local tmp; tmp="$(mktemp "$TEXTFILE.XXXXXX")"
  cat >"$tmp" <<EOF
# HELP areal_backup_last_run_timestamp_seconds Unix ts of last backup run.
# TYPE areal_backup_last_run_timestamp_seconds gauge
areal_backup_last_run_timestamp_seconds $(date +%s)
# HELP areal_backup_last_result Outcome of last backup. 1=ok, 0=fail.
# TYPE areal_backup_last_result gauge
areal_backup_last_result $result
# HELP areal_backup_last_duration_seconds Wall-clock duration of last backup.
# TYPE areal_backup_last_duration_seconds gauge
areal_backup_last_duration_seconds $duration
# HELP areal_backup_last_size_bytes Size of last encrypted dump.
# TYPE areal_backup_last_size_bytes gauge
areal_backup_last_size_bytes $size
EOF
  mv "$tmp" "$TEXTFILE"
  chmod 644 "$TEXTFILE"
}

# shellcheck disable=SC2329  # invoked indirectly via trap
cleanup_on_error() {
  local exit_code=$?
  if ((exit_code != 0)); then
    log "ERROR: backup failed (exit=$exit_code)"
    emit_metric 0 0 0
    rm -f "$out_plain" "$out_enc"
  fi
  exit "$exit_code"
}
trap cleanup_on_error EXIT

# ----------------------------------------------------------------------------
log "starting backup"

# Source backend .env for POSTGRES_USER/DB + BACKUP_* vars.
if [[ -f "$BACKEND_DIR/.env" ]]; then
  # shellcheck disable=SC1091
  set -a; source "$BACKEND_DIR/.env"; set +a
fi

: "${POSTGRES_USER:?POSTGRES_USER not set}"
: "${POSTGRES_DB:?POSTGRES_DB not set}"
: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE not set — generate with openssl rand -hex 32}"

mkdir -p "$LOCAL_DIR"
chmod 700 "$LOCAL_DIR"

start_ts=$(date +%s)

# ----------------------------------------------------------------------------
# Step 1: pg_dump from running container, piped through gzip.
# ----------------------------------------------------------------------------
log "dumping ${POSTGRES_DB} from container areal-postgres"
docker compose -f "$BACKEND_DIR/docker-compose.prod.yml" --env-file "$BACKEND_DIR/.env" exec -T postgres \
  pg_dump --clean --if-exists --no-owner --no-privileges -U "$POSTGRES_USER" "$POSTGRES_DB" \
  | gzip -9 > "$out_plain"

dump_size=$(stat -c%s "$out_plain" 2>/dev/null || stat -f%z "$out_plain")
log "dump size: $dump_size bytes (gzipped)"

# Sanity: dump should be > 1 KiB (an empty DB still has system catalogs).
if (( dump_size < 1024 )); then
  log "ERROR: dump suspiciously small ($dump_size bytes) — possible pg_dump failure"
  exit 1
fi

# ----------------------------------------------------------------------------
# Step 2: AES-256-CBC encrypt with PBKDF2 KDF.
# ----------------------------------------------------------------------------
log "encrypting"
openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt \
  -in "$out_plain" -out "$out_enc" \
  -pass "env:BACKUP_PASSPHRASE"

# Verify the encrypted file decrypts cleanly with the same passphrase.
# This catches a stale BACKUP_PASSPHRASE before we ship to remote storage.
if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
       -in "$out_enc" -pass "env:BACKUP_PASSPHRASE" \
       -out /dev/null 2>/dev/null; then
  log "ERROR: encryption self-check failed (passphrase mismatch?)"
  exit 1
fi

# Drop the plaintext copy ASAP.
rm -f "$out_plain"
enc_size=$(stat -c%s "$out_enc" 2>/dev/null || stat -f%z "$out_enc")
log "encrypted size: $enc_size bytes"

# ----------------------------------------------------------------------------
# Step 3: upload to S3-compatible storage (Cloudflare R2 / Backblaze B2).
# ----------------------------------------------------------------------------
if [[ -n "${BACKUP_S3_BUCKET:-}" ]]; then
  log "uploading to ${BACKUP_S3_BUCKET}/$(basename "$out_enc")"
  aws_args=()
  if [[ -n "${BACKUP_S3_ENDPOINT:-}" ]]; then
    aws_args+=(--endpoint-url "$BACKUP_S3_ENDPOINT")
  fi
  if ! command -v aws >/dev/null 2>&1; then
    log "ERROR: aws CLI not installed — install with: apt-get install awscli (or pipx install awscli)"
    exit 1
  fi
  aws "${aws_args[@]}" s3 cp "$out_enc" "$BACKUP_S3_BUCKET/$(basename "$out_enc")" \
    --only-show-errors
  log "remote upload OK"
else
  log "WARN: BACKUP_S3_BUCKET unset — skipping remote upload (LOCAL ONLY)"
fi

# ----------------------------------------------------------------------------
# Step 4: prune local copies older than retention window.
# ----------------------------------------------------------------------------
log "pruning local backups older than ${LOCAL_RETAIN} days"
find "$LOCAL_DIR" -type f -name 'areal-*.sql.gz.enc' -mtime "+$LOCAL_RETAIN" -print -delete

# ----------------------------------------------------------------------------
# Step 5: emit Prometheus metric (success path).
# ----------------------------------------------------------------------------
duration=$(( $(date +%s) - start_ts ))
emit_metric 1 "$duration" "$enc_size"
log "backup complete in ${duration}s"

# Defuse the error trap on clean exit.
trap - EXIT
exit 0
