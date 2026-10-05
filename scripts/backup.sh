#!/usr/bin/env bash
# =============================================================================
#  backup.sh — Sauvegarde locale des projets + volumes Docker
#
#    ./scripts/backup.sh            → /srv/backups/<date>/
#  Planifier chaque nuit :  crontab -e
#    15 3 * * * /chemin/vers/VPS1/scripts/backup.sh >/dev/null 2>&1
#
#  ⚠ Une sauvegarde sur la même machine ne protège pas d'une panne du VPS :
#    copie ensuite /srv/backups ailleurs (rsync, OVH Object Storage + restic…).
#  ⚠ Pour une base de données, préfère un dump (pg_dump / mysqldump) : copier
#    les fichiers d'une base en cours d'écriture peut donner une archive incohérente.
# =============================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
[[ -f $ROOT/infra/.env ]] && source "$ROOT/infra/.env"
PROJECTS_DIR="${PROJECTS_DIR:-/srv/projects}"
BACKUP_ROOT="${BACKUP_ROOT:-/srv/backups}"
KEEP_DAYS="${KEEP_DAYS:-7}"
DEST="$BACKUP_ROOT/$(date +%F_%H%M)"

mkdir -p "$DEST"
chmod 700 "$BACKUP_ROOT" "$DEST"  # les archives contiennent des secrets (clés TLS, .env)
echo "→ Projets ($PROJECTS_DIR)"
tar -czf "$DEST/projects.tar.gz" -C "$(dirname "$PROJECTS_DIR")" "$(basename "$PROJECTS_DIR")"
cp "$ROOT/infra/.env" "$DEST/infra.env" 2>/dev/null || true

echo "→ Volumes Docker"
for vol in $(docker volume ls -q --filter dangling=false); do
  [[ ${#vol} -eq 64 ]] && continue  # volumes anonymes
  docker run --rm -v "$vol:/v:ro" -v "$DEST:/b" alpine tar -czf "/b/vol-$vol.tar.gz" -C /v .
done

find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime +"$KEEP_DAYS" -exec rm -rf {} +
echo "✔ Sauvegarde : $DEST ($(du -sh "$DEST" | cut -f1))"
