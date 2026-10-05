#!/usr/bin/env bash
# =============================================================================
#  new-project.sh — Crée un nouveau projet prêt à être déployé
#
#    ./scripts/new-project.sh <nom> [domaine] [--up]
#
#  Exemples :
#    ./scripts/new-project.sh blog                 → https://blog.<DOMAIN>
#    ./scripts/new-project.sh site mondomaine.fr   → https://mondomaine.fr
#    ./scripts/new-project.sh api --up             → crée ET démarre
# =============================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
die() { printf '\e[1;31m✖ %s\e[0m\n' "$*" >&2; exit 1; }

UP=0
ARGS=()
for a in "$@"; do [[ $a == --up ]] && UP=1 || ARGS+=("$a"); done
NAME="${ARGS[0]:-}"
[[ -n $NAME ]] || die "Usage : $0 <nom> [domaine] [--up]"
[[ $NAME =~ ^[a-z0-9][a-z0-9-]{0,40}$ ]] || die "Nom invalide : minuscules, chiffres et tirets uniquement."

[[ -f $ROOT/infra/.env ]] || die "infra/.env introuvable : lance d'abord ./install.sh"
# shellcheck disable=SC1091
source "$ROOT/infra/.env"
HOST="${ARGS[1]:-$NAME.$DOMAIN}"
DEST="${PROJECTS_DIR:-/srv/projects}/$NAME"
[[ -e $DEST ]] && die "$DEST existe déjà."

mkdir -p "$DEST"
cp -r "$ROOT/projects/_template/." "$DEST/"
find "$DEST" -type f \( -name '*.yml' -o -name '*.html' -o -name '*.example' \) \
  -exec sed -i -e "s/__NAME__/$NAME/g" -e "s/__HOST__/$HOST/g" {} +

printf '\e[1;32m✔\e[0m Projet créé dans %s\n' "$DEST"
if [[ $UP == 1 ]]; then
  (cd "$DEST" && docker compose up -d)
  printf '\e[1;32m✔\e[0m En ligne sur https://%s (certificat émis en ~30 s)\n' "$HOST"
else
  cat <<MSG

  Prochaines étapes :
    cd $DEST
    # édite docker-compose.yml (image, port, description…)
    docker compose up -d

  → https://$HOST  (+ visible dans Mission Control)
MSG
fi
