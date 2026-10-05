#!/usr/bin/env bash
# =============================================================================
#  deploy-project.sh — Met à jour un projet depuis Git et le redéploie
#
#    ./scripts/deploy-project.sh <nom>
#
#  Le projet doit être un clone Git dans /srv/projects/<nom>, sur la branche
#  à publier, avec un docker-compose.yml à la racine.
#
#  Déploiement automatique (GitHub Actions) : une clé SSH dédiée, limitée à
#  cette seule commande dans ~/.ssh/authorized_keys :
#    command="/home/ubuntu/VPS1/scripts/deploy-project.sh <nom>",restrict ssh-ed25519 AAAA… gha-<nom>
# =============================================================================
set -euo pipefail
NAME="${1:-}"
[[ $NAME =~ ^[a-z0-9][a-z0-9-]{0,40}$ ]] || { echo "Usage : $0 <nom>" >&2; exit 1; }
DIR="${PROJECTS_DIR:-/srv/projects}/$NAME"
[[ -d $DIR/.git ]] || { echo "$DIR n'est pas un dépôt Git" >&2; exit 1; }
cd "$DIR"

# Un seul déploiement à la fois par projet
exec 9>"/tmp/deploy-$NAME.lock"
flock -w 600 9

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git fetch --quiet origin "$BRANCH"
git reset --quiet --hard "origin/$BRANCH"   # .env et les fichiers ignorés sont conservés
echo "→ $NAME @ $BRANCH : $(git log -1 --format='%h %s')"

docker compose up -d --build --remove-orphans
docker image prune -f >/dev/null
echo "✔ $NAME déployé"
