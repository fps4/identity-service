#!/usr/bin/env bash
#
# Nightly encrypted MongoDB backup for identity-service (ADR-0007). Complements the seed-from-git
# recovery of ADR-0006: that rebuilds the *definition* (tenants/clients/users), this captures the
# *runtime state* (issued tokens, authorizations, lockout counters, key history, audit log) for a true
# point-in-time restore.
#
# Runs on the ds1 HOST (where `docker` reaches the daemon and `age` is installed — same prerequisite as
# ADR-0006's SOPS). Dumps the DB via the running mongo container, encrypts the archive to the age
# recipient (the SAME master key that unlocks config/secrets.*.sops.yaml decrypts it), writes it to an
# off-host location, and prunes old snapshots.
#
#   backup.sh backup            # dump + encrypt + store + prune (the nightly action)
#   backup.sh restore <file>    # decrypt + mongorestore a snapshot (with confirmation)
#
# Schedule it from the host crontab (see docs/guides/deployment.md), e.g. nightly at 02:30:
#   30 2 * * *  AGE_RECIPIENT=age1... BACKUP_DIR=/mnt/backups /opt/identity-service/docker/backup.sh backup >> /var/log/is-backup.log 2>&1
#
set -euo pipefail

MONGO_CONTAINER="${MONGO_CONTAINER:-identity-service-mongo}"
DB="${MONGO_DB_NAME:-identity-service}"
BACKUP_DIR="${BACKUP_DIR:-/mnt/backups/identity-service}"   # point this at OFF-HOST storage (NFS/mount/rclone target)
RETENTION_DAYS="${RETENTION_DAYS:-30}"
# Public age recipient (encrypt-only) — defaults to the ADR-0006 master key's recipient (.sops.yaml).
AGE_RECIPIENT="${AGE_RECIPIENT:-age1nrlz6lv8rk37t4qtlkq5w90ewer9hk6uy7k9t04kchq6sc74qszq0y9qkh}"
# Optional: an rclone remote (e.g. `s3:my-bucket/identity-service`) to copy the encrypted snapshot
# truly off-host after writing it locally. Left empty, BACKUP_DIR alone is the off-host target.
RCLONE_REMOTE="${RCLONE_REMOTE:-}"

stamp() { date -u +%Y%m%d-%H%M%S; }

case "${1:-}" in
  backup)
    command -v age >/dev/null || { echo "::error:: age not installed (brew/apt install age)"; exit 1; }
    mkdir -p "$BACKUP_DIR"
    out="$BACKUP_DIR/${DB}-$(stamp).archive.gz.age"
    echo "==> Dumping '$DB' from '$MONGO_CONTAINER' → $out (age-encrypted)"
    docker exec "$MONGO_CONTAINER" sh -c "mongodump --db='$DB' --archive --gzip" \
      | age -r "$AGE_RECIPIENT" -o "$out"
    echo "    wrote $(du -h "$out" | cut -f1)"

    if [ -n "$RCLONE_REMOTE" ]; then
      echo "==> Copying off-host to $RCLONE_REMOTE"
      rclone copy "$out" "$RCLONE_REMOTE"
    fi

    echo "==> Pruning snapshots older than ${RETENTION_DAYS}d in $BACKUP_DIR"
    find "$BACKUP_DIR" -name "${DB}-*.archive.gz.age" -type f -mtime "+${RETENTION_DAYS}" -print -delete || true
    echo "    done."
    ;;

  restore)
    file="${2:-}"
    [ -f "$file" ] || { echo "usage: $0 restore <snapshot.archive.gz.age>"; exit 2; }
    [ -n "${SOPS_AGE_KEY:-}${SOPS_AGE_KEY_FILE:-}" ] || { echo "::error:: set SOPS_AGE_KEY (or SOPS_AGE_KEY_FILE) — the master key — to decrypt"; exit 1; }
    echo "==> Restoring $file into '$DB' on '$MONGO_CONTAINER' (existing collections will be DROPPED)"
    read -r -p "    Confirm restore? [type 'yes'] " ans; [ "$ans" = "yes" ] || { echo "    aborted."; exit 1; }
    age -d "$file" | docker exec -i "$MONGO_CONTAINER" sh -c "mongorestore --db='$DB' --archive --gzip --drop"
    echo "    restore complete."
    ;;

  *) echo "usage: $0 {backup|restore <file>}"; exit 2 ;;
esac
