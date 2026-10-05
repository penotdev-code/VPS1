#!/usr/bin/env bash
# update.sh — Met à jour ce dépôt + les images de la stack d'infra, puis nettoie.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
git pull --ff-only
(cd infra && docker compose pull --ignore-buildable && docker compose up -d --build --remove-orphans)
docker image prune -f
echo "✔ Infra à jour"
