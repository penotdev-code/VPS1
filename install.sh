#!/usr/bin/env bash
# =============================================================================
#  install.sh — Déploie la stack d'infra : Traefik (HTTPS auto) + Mission Control
#  À lancer avec l'utilisateur admin (membre du groupe docker), après bootstrap.sh
#  Relançable sans risque : il met simplement la stack à jour.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"
ENV_FILE="$ROOT/infra/.env"
USERS_FILE="$ROOT/infra/traefik/auth/users"

c_blue=$'\e[1;34m'; c_green=$'\e[1;32m'; c_yellow=$'\e[1;33m'; c_red=$'\e[1;31m'; c_off=$'\e[0m'
step() { printf '\n%s==>%s %s\n' "$c_blue" "$c_off" "$*"; }
ok()   { printf '  %s✔%s %s\n' "$c_green" "$c_off" "$*"; }
warn() { printf '  %s!%s %s\n' "$c_yellow" "$c_off" "$*"; }
die()  { printf '%s✖ %s%s\n' "$c_red" "$*" "$c_off" >&2; exit 1; }

command -v docker >/dev/null || die "Docker n'est pas installé. Lance d'abord : sudo ./bootstrap.sh"
docker info >/dev/null 2>&1 || die "Impossible de parler à Docker. Déconnecte-toi / reconnecte-toi (groupe docker) ou utilise sudo."
docker compose version >/dev/null 2>&1 || die "Le plugin 'docker compose' est manquant."

# -----------------------------------------------------------------------------
step "Configuration"
if [[ ! -f $ENV_FILE ]]; then
  read -rp "  Nom de domaine (ex: mondomaine.fr) : " DOMAIN
  DOMAIN="${DOMAIN,,}"; DOMAIN="${DOMAIN#http*://}"; DOMAIN="${DOMAIN%/}"
  [[ $DOMAIN =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || die "Domaine invalide : $DOMAIN"
  read -rp "  Email pour Let's Encrypt (alertes d'expiration) : " ACME_EMAIL
  [[ $ACME_EMAIL == *@*.* ]] || die "Email invalide."
  read -rp "  Sous-domaine du dashboard [dash] : " SUB; SUB="${SUB:-dash}"
  cat > "$ENV_FILE" <<ENV
# Généré par install.sh — ne pas commiter
DOMAIN=$DOMAIN
ACME_EMAIL=$ACME_EMAIL
DASHBOARD_HOST=$SUB.$DOMAIN
TRAEFIK_HOST=traefik.$DOMAIN
PROJECTS_DIR=/srv/projects
TZ=Europe/Paris
ENV
  chmod 600 "$ENV_FILE"
  ok "infra/.env créé"
else
  ok "infra/.env existant réutilisé"
fi
# shellcheck disable=SC1090
source "$ENV_FILE"

# -----------------------------------------------------------------------------
step "Identifiants du dashboard"
if [[ ! -s $USERS_FILE ]]; then
  read -rp "  Identifiant [admin] : " DASH_USER; DASH_USER="${DASH_USER:-admin}"
  read -rsp "  Mot de passe (vide = généré automatiquement) : " DASH_PASS; echo
  GENERATED=0
  if [[ -z $DASH_PASS ]]; then
    DASH_PASS="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"
    GENERATED=1
  fi
  if command -v htpasswd >/dev/null; then
    htpasswd -nbB "$DASH_USER" "$DASH_PASS" > "$USERS_FILE"
  else
    printf '%s:%s\n' "$DASH_USER" "$(openssl passwd -apr1 "$DASH_PASS")" > "$USERS_FILE"
  fi
  chmod 644 "$USERS_FILE"
  ok "Utilisateur '$DASH_USER' créé"
  [[ $GENERATED == 1 ]] && printf '  %sMot de passe généré : %s%s  (note-le, il ne sera plus affiché)\n' "$c_yellow" "$DASH_PASS" "$c_off"
else
  ok "Identifiants existants conservés (supprime infra/traefik/auth/users pour les régénérer)"
fi

# -----------------------------------------------------------------------------
step "Vérification DNS"
IP4="$(curl -fsS4 --max-time 5 https://api.ipify.org 2>/dev/null || true)"
dns_ok=1
for h in "$DASHBOARD_HOST" "$TRAEFIK_HOST"; do
  resolved="$(getent ahostsv4 "$h" | awk 'NR==1{print $1}')"
  if [[ -n $IP4 && $resolved == "$IP4" ]]; then
    ok "$h → $resolved"
  else
    warn "$h → ${resolved:-introuvable} (attendu : ${IP4:-IP du VPS})"
    dns_ok=0
  fi
done
if [[ $dns_ok == 0 ]]; then
  warn "Les certificats HTTPS ne pourront être émis qu'une fois le DNS correct (voir README → DNS)."
  warn "Traefik réessaiera automatiquement, tu peux continuer."
fi

# -----------------------------------------------------------------------------
step "Démarrage de la stack"
docker network inspect proxy >/dev/null 2>&1 || docker network create proxy >/dev/null
( cd infra && docker compose pull --quiet --ignore-buildable && docker compose up -d --build --remove-orphans )
ok "Stack démarrée"
( cd infra && docker compose ps --format 'table {{.Name}}\t{{.Status}}' )

cat <<MSG

${c_green}✔ C'est en ligne !${c_off}

   Mission Control   →  https://$DASHBOARD_HOST
   Traefik           →  https://$TRAEFIK_HOST

   Nouveau projet    →  ./scripts/new-project.sh mon-app

   (Le premier certificat HTTPS peut prendre ~30 s à être émis.)

MSG
