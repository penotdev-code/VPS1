# Contexte pour Claude — VPS1

Ce fichier transmet le contexte d'une session précédente. Lis-le, puis le README.

## Le projet
L'utilisateur (francophone, sur **Android**, débutant-intermédiaire) a un **VPS OVH** et un
**nom de domaine chez OVH**. Ce dépôt contient un setup complet, déjà écrit et testé hors-ligne :

- `bootstrap.sh` (root, une fois) : MAJ, user admin, SSH par clé uniquement, UFW (22/80/443),
  Fail2ban, unattended-upgrades, swap, Docker, réseau `proxy`, `/srv/projects`, `/srv/backups`.
- `install.sh` (user admin) : crée `infra/.env` (domaine, email, sous-domaine du dashboard),
  génère l'auth basique (`infra/traefik/auth/users`), vérifie le DNS, lance `infra/docker-compose.yml`
  → Traefik v3 (Let's Encrypt HTTP-01) + docker-socket-proxy + **Mission Control** (`dashboard/`, Node sans dépendance).
- `scripts/new-project.sh`, `update.sh`, `backup.sh` ; modèle dans `projects/_template/`.
- Le dashboard a été testé contre une fausse API Docker ; les scripts n'ont **jamais tourné sur un vrai serveur**.
  Le premier vrai lancement est donc à surveiller de près et à corriger dans le dépôt si besoin.

Le code est sur la branche `ccr-73069a2d-lw0cj0`.

## Pourquoi une nouvelle session
La session précédente tournait dans le cloud Anthropic : SSH sortant impossible (proxy HTTP(S) uniquement).
L'utilisateur utilise maintenant **Remote Control** depuis une machine qui peut faire du SSH.

## État du VPS au moment du passage de relais
- Réinstallé sous **Ubuntu 24.04** (utilisateur `ubuntu`) avec **une seule clé SSH : celle de l'ancienne
  session cloud (`claude-code-session`), désormais inutilisable**. À vérifier avec l'utilisateur.
- Si personne ne peut s'y connecter : génère une clé ici (`ssh-keygen -t ed25519`), donne la clé
  **publique** à l'utilisateur, et guide-le pour réinstaller le VPS depuis le Manager OVH (Bare Metal Cloud
  → VPS → « … » à côté de l'OS → Réinstaller → Ubuntu 24.04 → coller la clé). Le VPS est vide, ça ne coûte rien.
- Le DNS n'est peut-être pas encore fait : 2 enregistrements `A` (sous-domaine vide et `*`) → IPv4 du VPS,
  dans Web Cloud → Noms de domaine → Zone DNS. Seul l'utilisateur peut le faire (pas d'accès OVH).
- Le dépôt GitHub est **privé** : pour le cloner sur le VPS, il faut soit le passer en public (il ne contient
  aucun secret), soit transférer les fichiers via `scp`/`rsync` depuis ta machine (plus simple).

## Ce qu'il reste à faire
1. Demander : IP du VPS, domaine, email (Let's Encrypt), identifiant du dashboard.
2. Accès SSH à `ubuntu@IP`.
3. Copier le dépôt sur le VPS (`rsync -av --exclude .git ./ ubuntu@IP:~/VPS1/` ou `git clone`).
4. `sudo ./bootstrap.sh` (ADMIN_USER=ubuntu). Le script désactive l'auth par mot de passe :
   **garde la connexion ouverte et vérifie qu'une nouvelle connexion fonctionne avant de fermer.**
   **Ajoute aussi la clé SSH personnelle de l'utilisateur** (Termux) pour qu'il garde un accès indépendant,
   et propose un mot de passe pour `ubuntu` (utile pour la console KVM d'OVH en secours).
5. Se reconnecter (groupe docker), puis `./install.sh` (interactif : utilise `printf` ou crée
   `infra/.env` à la main). Pour le mot de passe du dashboard, laisse-le générer et donne-le à l'utilisateur.
6. Vérifier : `docker compose ps` dans `infra/`, certificats émis (`docker logs traefik`), dashboard sur
   `https://dash.<domaine>`, puis `./scripts/new-project.sh hello --up` comme démo.
7. Corriger dans le dépôt tout bug rencontré, commit et push sur la branche.

## Préférences et ton
- Répondre en **français**, phrases simples, étapes numérotées : l'utilisateur est sur téléphone.
- Ne jamais lui faire coller de secrets dans le chat s'il y a une autre solution.
- Règle d'or des projets : **jamais de `ports:`** (Docker contourne UFW), tout passe par Traefik et le réseau `proxy`.
- Suites conseillées, après l'installation : sauvegardes hors VPS (option OVH ou restic → Object Storage),
  CI/CD GitHub Actions → GHCR → `docker compose pull`, alertes (ntfy).
