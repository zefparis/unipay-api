#!/usr/bin/env bash
# Build atomique : compile dans dist.new, ne remplace dist/ qu'en cas
# de succès. dist.prev est conservé pour le retour arrière.
# Jamais de dist/ vide à l'exécution : renommage quasi instantané.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[build] nettoyage dist.new + compilation tsc → dist.new"
rm -rf dist.new
npx tsc --outDir dist.new

[ -s dist.new/app.js ] || { echo "[build] ECHEC : dist.new/app.js absent — dist/ inchangé" >&2; exit 1; }

echo "[build] bascule : dist → dist.prev, dist.new → dist"
rm -rf dist.prev
[ -d dist ] && mv dist dist.prev
mv dist.new dist

echo "[build] OK — rollback possible via : mv dist.prev dist"
