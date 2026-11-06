# UniPay API — Agent Guide

## Build & Test

- Build : `npm run build` → `scripts/build-safe.sh` (compile dans `dist.new`,
  bascule atomique `dist`→`dist.prev` ; jamais de `dist/` vide)
- Typecheck : `npx tsc --noEmit`
- Tests : `npx tsx --test src/lib/__tests__/*.test.ts` (style node:test +
  assertions source ; `npx vitest run` est l'autre runner du repo — 21 échecs
  pré-existants dans des tests obsolètes, hors périmètre)

## Déploiement — OBLIGATOIREMENT via scripts/deploy-x3.sh

- Cible : x3 (`unipaycongo@192.168.1.166`, sudo NOPASSWD), `/opt/unipay-api`,
  service `unipay-api` (User=unipay, `ProtectSystem=strict`, node `dist/app.js`)
- Le script refuse de déployer hors branche `main` ou avec des modifs non
  commitées (`--force` pour passer outre), bloque si `rsync -n --delete`
  supprimerait des fichiers de `src/ scripts/ supabase/` sur x3, build
  atomique, healthcheck `:3100/health` (fenêtre ~90 s, boot ~25 s), rollback
  auto sur `dist.prev`
- NE JAMAIS éditer `/opt/unipay-api` directement ni rsync manuel
- Secrets/env : `/etc/unipay-api.env` (root 600) — jamais copié sur x2

## RÈGLE — jamais de tests ni fixtures en production

Interdiction de créer des comptes, d'envoyer des fichiers (uploads KYC ou
autres) ou de lancer des tests contre la production : unipaycongo.com,
api.unipaycongo.com, base Supabase de prod. Les tests se font en local ou sur
un environnement de test. Des fixtures de test détectées en prod
(comptes @fldubai.com/@example.com, fichiers "evil.pdf") sont à signaler et à
nettoyer — 12 comptes suspendus le 2026-11-06, en attente de suppression.

## RÈGLE — flux de paiement gelé

Aucune modification de `src/routes/payment/callback.ts`,
`src/services/unipesa-reconciliation.ts` ou des RPC de paiement
(`process_wallet_provider_callback`, `wallet_withdraw_*`,
`initiate_merchant_payout`, `credit_partner_commission`,
`backfill_partner_commissions`, `mark_settlement_*`) sans accord explicite de
l'utilisateur — même pour un paramètre.

## Planification x3

- `unipay-kyc-reminders.timer` : tous les jours 08:00 CET →
  `tsx scripts/kyc-reminders.ts` (User=unipay). Dry-run possible :
  `sudo systemd-run --wait --pipe -p EnvironmentFile=/etc/unipay-api.env
  -p WorkingDirectory=/opt/unipay-api -p User=unipay
  /opt/unipay-api/node_modules/.bin/tsx scripts/kyc-reminders.ts --dry-run --at YYYY-MM-DD`

## Base Supabase

- Pas d'accès DDL : les migrations `supabase/migrations/*.sql` sont appliquées
  à la main dans Supabase par l'utilisateur
- Flags marchand : `merchants.email_unreachable` (colonne, source de vérité) +
  `merchant_kyc_events` (trace)
