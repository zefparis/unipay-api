#!/usr/bin/env bash
# Déploiement unipay-api → x3 (unipaycongo@192.168.1.166, sudo NOPASSWD).
# À lancer depuis x2, racine du dépôt ou n'importe où :
#   bash scripts/deploy-x3.sh
#
# Étapes : sauvegarde horodatée (5 conservées) → rsync sources → npm ci si
# package-lock a changé → build atomique (scripts/build-safe.sh) → restart
# → healthcheck :3100/health → rollback auto sur dist.prev si KO.
set -euo pipefail

FORCE=0
for arg in "$@"; do [ "$arg" = "--force" ] && FORCE=1; done

# ── 0. Garde git : seule la branche main, arbre propre ────────────
LOCAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BRANCH="$(git -C "$LOCAL_DIR" rev-parse --abbrev-ref HEAD)"
DIRTY="$(git -C "$LOCAL_DIR" status --porcelain | grep -v '^??' || true)"
if [ "$BRANCH" != "main" ] || [ -n "$DIRTY" ]; then
  warn "branche=$BRANCH, modifs non commitées=${DIRTY:+oui}"
  [ "$FORCE" -eq 1 ] || die "déploiement refusé : mergez dans main et committez (ou --force)"
  warn "--force : déploiement depuis $BRANCH malgré tout"
fi

X3="unipaycongo@192.168.1.166"
APP=/opt/unipay-api
BACKUP_DIR=/opt/unipay-api-backups
HEALTH_URL="http://localhost:3100/health"
TS="$(date +%Y%m%d-%H%M%S)"

step() { printf '\n\033[1;36m══ %s ══\033[0m\n' "$*"; }
ok()   { printf '  \033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '  \033[1;33m! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

ssh -o BatchMode=yes -o ConnectTimeout=10 "$X3" true || die "SSH $X3 injoignable"

# ── 1. Sauvegarde sur x3 (5 dernières conservées) ─────────────────
step "1/6 sauvegarde $APP → $BACKUP_DIR/unipay-api-$TS"
ssh "$X3" "sudo install -d -o unipaycongo -g unipaycongo $BACKUP_DIR \
  && cp -a $APP $BACKUP_DIR/unipay-api-$TS \
  && ls -dt $BACKUP_DIR/unipay-api-* 2>/dev/null | tail -n +6 | xargs -r rm -rf \
  && ls -dt $BACKUP_DIR/unipay-api-*"
ok "sauvegarde créée, rétention 5"

# ── 2. package-lock inchangé ? (avant rsync, pour décider du npm ci) ──
LOCAL_HASH="$(sha256sum "$LOCAL_DIR/package-lock.json" | cut -d' ' -f1)"
REMOTE_HASH="$(ssh "$X3" "sha256sum $APP/package-lock.json 2>/dev/null | cut -d' ' -f1" || true)"
NEED_NPM_CI=0
[ "$LOCAL_HASH" != "$REMOTE_HASH" ] && NEED_NPM_CI=1

# ── 3. Pré-vol : fichiers qui seraient SUPPRIMÉS sur x3 ───────────
# rsync --delete efface tout fichier x3 absent du dépôt. Un code écrit
# directement en prod (non commité) serait perdu — on bloque par défaut.
step "2/6 pré-vol rsync -n --delete (détection suppressions)"
TO_DELETE="$(rsync -azn --delete --itemize-changes \
  --exclude node_modules --exclude .git --exclude '.env*' \
  --exclude 'dist*' --exclude '.npm' --exclude '*.bak*' \
  "$LOCAL_DIR/" "$X3:$APP/" | grep '^\*deleting' | grep -vE '^\*deleting *(scripts|src|supabase)/? *$' | grep -E '^\*deleting *(src/|scripts/|supabase/)' || true)"
if [ -n "$TO_DELETE" ]; then
  warn "des fichiers x3 seraient SUPPRIMÉS (absents du dépôt) :"
  echo "$TO_DELETE"
  [ "$FORCE" -eq 1 ] || die "déploiement annulé — rapatriez ces fichiers dans le dépôt, ou relancez avec --force"
  warn "--force : suppression acceptée"
else
  ok "aucune suppression dans src/ scripts/ supabase/"
fi

step "3/6 rsync sources → x3:$APP"
rsync -az --delete --itemize-changes \
  --exclude node_modules --exclude .git --exclude '.env*' \
  --exclude 'dist*' --exclude '.npm' --exclude '*.bak*' \
  "$LOCAL_DIR/" "$X3:$APP/" | head -40
ok "sources synchronisées"

# ── 4. npm ci (seulement si package-lock a changé) ────────────────
if [ "$NEED_NPM_CI" -eq 1 ]; then
  step "4/6 npm ci (package-lock.json modifié)"
  ssh "$X3" "cd $APP && npm ci --no-audit --no-fund"
  ok "dépendances installées"
else
  step "4/6 npm ci — ignoré (package-lock.json inchangé)"
fi

# ── 5. Build atomique ─────────────────────────────────────────────
step "5/6 build (dist.new → bascule dist/)"
ssh "$X3" "cd $APP && bash scripts/build-safe.sh"
ok "dist/ régénéré, dist.prev conservé"

# ── 6. Restart + healthcheck ──────────────────────────────────────
step "6/6 restart unipay-api + healthcheck"
ssh "$X3" "sudo systemctl restart unipay-api"
HEALTHY=0
# boot du service ~25 s observés → fenêtre ~90 s
for i in $(seq 1 30); do
  CODE="$(ssh "$X3" "curl -s -o /dev/null -w '%{http_code}' --max-time 3 $HEALTH_URL" || true)"
  [ "$CODE" = "200" ] && { HEALTHY=1; break; }
  sleep 3
done

if [ "$HEALTHY" -eq 1 ]; then
  ok "service active + $HEALTH_URL → 200"
  step "6/6 journalctl depuis le restart"
  ssh "$X3" "journalctl -u unipay-api --since '-30s' --no-pager -p err | tail -10"
  echo
  ok "déploiement $TS terminé"
else
  step "ROLLBACK : healthcheck KO → retour à dist.prev"
  ssh "$X3" "cd $APP && rm -rf dist && [ -d dist.prev ] && mv dist.prev dist && sudo systemctl restart unipay-api"
  sleep 3
  CODE="$(ssh "$X3" "curl -s -o /dev/null -w '%{http_code}' --max-time 3 $HEALTH_URL" || true)"
  if [ "$CODE" = "200" ]; then
    warn "rollback OK (dist.prev restauré, santé 200) — MAIS le déploiement a ÉCHOUÉ"
  else
    die "ROLLBACK KO — santé=$CODE — intervention manuelle requise sur x3"
  fi
  ssh "$X3" "journalctl -u unipay-api --since '-2min' --no-pager | tail -30"
  exit 1
fi
