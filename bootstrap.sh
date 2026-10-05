#!/usr/bin/env bash
# =============================================================================
#  bootstrap.sh — Premier setup & sécurisation d'un VPS OVH (Ubuntu / Debian)
# -----------------------------------------------------------------------------
#  À lancer UNE fois, en root, sur un VPS fraîchement installé :
#
#     sudo ./bootstrap.sh
#
#  Variables optionnelles :
#     ADMIN_USER=ubuntu     utilisateur admin (défaut : celui qui lance sudo)
#     TIMEZONE=Europe/Paris
#     SWAP_SIZE=2G          taille du swap créé s'il n'y en a pas (0 = aucun)
#     AUTO_REBOOT=true      redémarrage auto à 04:30 si une MAJ de sécu l'exige
#     PROJECTS_DIR=/srv/projects
# =============================================================================
set -euo pipefail

ADMIN_USER="${ADMIN_USER:-${SUDO_USER:-}}"
TIMEZONE="${TIMEZONE:-Europe/Paris}"
SWAP_SIZE="${SWAP_SIZE:-2G}"
AUTO_REBOOT="${AUTO_REBOOT:-true}"
PROJECTS_DIR="${PROJECTS_DIR:-/srv/projects}"

c_blue=$'\e[1;34m'; c_green=$'\e[1;32m'; c_yellow=$'\e[1;33m'; c_red=$'\e[1;31m'; c_off=$'\e[0m'
step() { printf '\n%s==>%s %s\n' "$c_blue" "$c_off" "$*"; }
ok()   { printf '  %s✔%s %s\n' "$c_green" "$c_off" "$*"; }
warn() { printf '  %s!%s %s\n' "$c_yellow" "$c_off" "$*"; }
die()  { printf '%s✖ %s%s\n' "$c_red" "$*" "$c_off" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Lance ce script en root : sudo ./bootstrap.sh"
[[ -r /etc/os-release ]] || die "OS non reconnu."
# shellcheck disable=SC1091
. /etc/os-release
[[ ${ID:-} == ubuntu || ${ID:-} == debian ]] || die "OS supporté : Ubuntu ou Debian (détecté : ${ID:-?})."

if [[ -z $ADMIN_USER || $ADMIN_USER == root ]]; then
  read -rp "Nom de l'utilisateur admin à utiliser / créer (ex: ubuntu) : " ADMIN_USER
fi
[[ $ADMIN_USER =~ ^[a-z_][a-z0-9_-]{0,31}$ && $ADMIN_USER != root ]] || die "Nom d'utilisateur invalide : '$ADMIN_USER'"

echo "${c_blue}VPS bootstrap${c_off} — ${PRETTY_NAME} — admin : ${ADMIN_USER}"

# -----------------------------------------------------------------------------
step "Mise à jour du système et paquets de base"
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
apt-get update -q
apt-get -yq -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade
apt-get install -yq --no-install-recommends \
  ca-certificates curl gnupg git ufw fail2ban python3-systemd \
  unattended-upgrades apt-listchanges htop jq ncdu tmux rsync unzip apache2-utils
ok "Système à jour"

# -----------------------------------------------------------------------------
step "Fuseau horaire : $TIMEZONE"
timedatectl set-timezone "$TIMEZONE" 2>/dev/null || ln -sf "/usr/share/zoneinfo/$TIMEZONE" /etc/localtime
ok "$(date)"

# -----------------------------------------------------------------------------
step "Utilisateur admin : $ADMIN_USER"
if ! id "$ADMIN_USER" &>/dev/null; then
  adduser --disabled-password --gecos "" "$ADMIN_USER"
  usermod -aG sudo "$ADMIN_USER"
  echo "  Choisis un mot de passe pour '$ADMIN_USER' (utilisé uniquement pour sudo) :"
  passwd "$ADMIN_USER"
  ok "Utilisateur créé"
else
  usermod -aG sudo "$ADMIN_USER"
  ok "Utilisateur existant"
fi

ADMIN_HOME="$(getent passwd "$ADMIN_USER" | cut -d: -f6)"
AUTH_KEYS="$ADMIN_HOME/.ssh/authorized_keys"
install -d -m 700 -o "$ADMIN_USER" -g "$ADMIN_USER" "$ADMIN_HOME/.ssh"
touch "$AUTH_KEYS"

# Récupère les clés SSH de root / des utilisateurs cloud par défaut d'OVH.
# On ne garde que la clé elle-même (OVH préfixe celles de root par un
# `command="echo 'Please login as ubuntu'"` qui bloquerait la connexion).
KEY_RE='(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp[0-9]+|sk-[a-z0-9@.-]+) [A-Za-z0-9+/=]+( .*)?$'
for src in /root/.ssh/authorized_keys /home/ubuntu/.ssh/authorized_keys /home/debian/.ssh/authorized_keys; do
  [[ -s $src && $src != "$AUTH_KEYS" ]] && grep -oE "$KEY_RE" "$src" >> "$AUTH_KEYS" || true
done
sort -u "$AUTH_KEYS" -o "$AUTH_KEYS"
chown "$ADMIN_USER:$ADMIN_USER" "$AUTH_KEYS"
chmod 600 "$AUTH_KEYS"
KEY_COUNT="$(grep -cE "$KEY_RE" "$AUTH_KEYS" || true)"
ok "$KEY_COUNT clé(s) SSH autorisée(s) pour $ADMIN_USER"

# -----------------------------------------------------------------------------
step "Durcissement SSH"
if [[ $KEY_COUNT -gt 0 ]]; then
  # Préfixe 00- : sshd garde la première valeur lue, on passe donc avant
  # le 50-cloud-init.conf qui réactive parfois l'auth par mot de passe.
  cat > /etc/ssh/sshd_config.d/00-hardening.conf <<'EOF'
# Géré par bootstrap.sh
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
MaxAuthTries 3
LoginGraceTime 30
X11Forwarding no
ClientAliveInterval 300
ClientAliveCountMax 2
EOF
  mkdir -p /run/sshd
  if sshd -t; then
    systemctl reload ssh 2>/dev/null || systemctl reload sshd
    ok "Connexion root et mots de passe désactivés (clés SSH uniquement)"
  else
    rm -f /etc/ssh/sshd_config.d/00-hardening.conf
    warn "Config sshd invalide, durcissement annulé."
  fi
else
  warn "Aucune clé SSH trouvée pour $ADMIN_USER : durcissement SSH IGNORÉ pour ne pas te bloquer."
  warn "Ajoute ta clé dans $AUTH_KEYS puis relance ce script."
fi

# -----------------------------------------------------------------------------
step "Pare-feu (UFW)"
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp  comment 'SSH'   >/dev/null
ufw allow 80/tcp  comment 'HTTP'  >/dev/null
ufw allow 443/tcp comment 'HTTPS' >/dev/null
ufw allow 443/udp comment 'HTTP/3' >/dev/null
ufw --force enable >/dev/null
ok "Ouverts : 22, 80, 443 — tout le reste est bloqué"

# -----------------------------------------------------------------------------
step "Fail2ban (anti brute-force SSH)"
cat > /etc/fail2ban/jail.d/sshd.local <<'EOF'
[sshd]
enabled = true
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h
bantime.increment = true
bantime.maxtime = 1w
EOF
systemctl enable --now fail2ban >/dev/null 2>&1
systemctl restart fail2ban
ok "Fail2ban actif"

# -----------------------------------------------------------------------------
step "Mises à jour de sécurité automatiques"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
cat > /etc/apt/apt.conf.d/52unattended-upgrades-local <<EOF
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "${AUTO_REBOOT}";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
EOF
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true
ok "unattended-upgrades actif (reboot auto : $AUTO_REBOOT)"

# -----------------------------------------------------------------------------
step "Swap & réglages noyau"
if [[ $SWAP_SIZE != 0 ]] && [[ -z $(swapon --show --noheadings) ]]; then
  fallocate -l "$SWAP_SIZE" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  ok "Swap de $SWAP_SIZE créé"
else
  ok "Swap déjà présent (ou désactivé)"
fi
cat > /etc/sysctl.d/99-vps.conf <<'EOF'
vm.swappiness = 10
fs.inotify.max_user_watches = 524288
net.core.somaxconn = 4096
net.ipv4.tcp_syncookies = 1
EOF
sysctl --system >/dev/null
ok "sysctl appliqué"

# -----------------------------------------------------------------------------
step "Docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
install -d /etc/docker
cat > /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" },
  "live-restore": true
}
EOF
systemctl enable docker >/dev/null 2>&1
systemctl restart docker
usermod -aG docker "$ADMIN_USER"
docker network inspect proxy >/dev/null 2>&1 || docker network create proxy >/dev/null
ok "$(docker --version) — réseau 'proxy' prêt"

# -----------------------------------------------------------------------------
step "Dossiers : $PROJECTS_DIR et /srv/backups"
install -d -o "$ADMIN_USER" -g "$ADMIN_USER" "$PROJECTS_DIR" /srv/backups
ok "Prêt"

# -----------------------------------------------------------------------------
IP4="$(curl -fsS4 --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
cat <<EOF

${c_green}✔ Bootstrap terminé !${c_off}

  ${c_yellow}IMPORTANT${c_off} — avant de fermer cette session, ouvre un NOUVEAU terminal et vérifie :
      ssh ${ADMIN_USER}@${IP4}

  Ensuite (reconnecte-toi pour que le groupe 'docker' soit pris en compte) :
      cd $(pwd) && ./install.sh

EOF
