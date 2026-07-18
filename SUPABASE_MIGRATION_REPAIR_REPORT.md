# SUPABASE MIGRATION REPAIR REPORT

## A. Cause racine initiale

L'erreur `foreign key constraint "transactions_merchant_id_fkey" cannot be implemented — Key columns "merchant_id" and "id" are of incompatible types: text and uuid` provenait de la migration `20260604000000_transactions_v2.sql` qui créait `transactions.merchant_id` en type `text` alors que `operators.id` (la PK référencée) est de type `uuid`.

**Cause profonde**: La migration `20260604000001_unipay_full_schema.sql` recréait ensuite la table `transactions` avec `merchant_id uuid` (correct), mais la migration `20260604000000` échouait avant d'atteindre `20260604000001` car la FK `text → uuid` est rejetée par PostgreSQL.

## B. Toutes les erreurs rencontrées

| # | Migration | Erreur | Cause racine | Correction |
|---|-----------|--------|--------------|------------|
| 1 | `20260604000000_transactions_v2.sql` | `FK type mismatch: text vs uuid` sur `transactions.merchant_id → operators.id` | `merchant_id` déclaré `text` au lieu de `uuid` | Changé `text` → `uuid` dans la migration historique (pour reset local) + migration corrective `20260719000000` pour bases existantes |
| 2 | `20260701000000_adi_deposit_from_address.sql` | `relation "adi_deposit_events" does not exist` | Table `adi_deposit_events` jamais créée par une migration (ajoutée manuellement en production) | Création de `20260700999999_adi_deposit_events_create.sql` |
| 3 | `20260701000001_adi_deposit_user_id_nullable.sql` | Même cause que #2 | Même correction (la table existe désormais) |
| 4 | `config.toml` | `seed.sql` manquant référencé par `sql_paths = ["./seed.sql"]` | Fichier `seed.sql` jamais créé | Créé `supabase/seed.sql` (vide, les seeds sont dans les migrations) |
| 5 | `20260718220000_dev_expenses_v4_transactional_rpc.sql` | `input parameters after one with a default value must also have defaults` | `p_amount NUMERIC(14,2)` sans default après `p_payer_entity_id UUID DEFAULT NULL` | Ajouté `DEFAULT NULL` à `p_amount` |
| 6 | `20260718200000_dev_expenses_v4_billing_recipient.sql` | `cannot change name of view column "amount_usd" to "billing_recipient_entity_id"` | `CREATE OR REPLACE VIEW` ne permet pas d'insérer des colonnes au milieu | Remplacé par `DROP VIEW IF EXISTS` + `CREATE VIEW` |
| 7 | `20260718210000_dev_expenses_v4_legal_profile_and_roles.sql` | Même erreur que #6 | Même correction |
| 8 | Code backend | `wallet_users` manque colonnes `email` et `lang` | Colonnes ajoutées manuellement en production sans migration | Créé `20260610160000_wallet_email_lang.sql` |
| 9 | Docker/Windows | Port conflicts sur 54321, 54323, 54327, 54432 | Plage de ports exclue par Windows (54259-54358) | Changé tous les ports vers 55000+ dans `config.toml` |

## C. Fichiers modifiés

### Migrations historiques corrigées (pour reset local)

| Fichier | Modification |
|---------|-------------|
| `20260604000000_transactions_v2.sql` | `merchant_id text` → `merchant_id uuid` |
| `20260718200000_dev_expenses_v4_billing_recipient.sql` | `CREATE OR REPLACE VIEW` → `DROP VIEW IF EXISTS` + `CREATE VIEW` |
| `20260718210000_dev_expenses_v4_legal_profile_and_roles.sql` | Idem |
| `20260718220000_dev_expenses_v4_transactional_rpc.sql` | `p_amount NUMERIC(14,2)` → `p_amount NUMERIC(14,2) DEFAULT NULL` |

### Nouvelles migrations créées

| Fichier | Type | Purpose |
|---------|------|---------|
| `20260610160000_wallet_email_lang.sql` | Historique manquante | Ajoute colonnes `email` et `lang` à `wallet_users` |
| `20260700999999_adi_deposit_events_create.sql` | Historique manquante | Crée la table `adi_deposit_events` |
| `20260719000000_fix_transactions_merchant_id_type.sql` | Corrective (pour bases existantes) | Convertit `merchant_id text` → `uuid` de manière idempotente |

### Autres fichiers modifiés

| Fichier | Modification |
|---------|-------------|
| `supabase/config.toml` | Ports changés vers 55000+ (Windows excluded range), analytics désactivé |
| `supabase/seed.sql` | Créé (fichier vide avec commentaire) |
| `supabase/diagnostics/v4_migration_check.sql` | Étendu avec 6 nouvelles vérifications (GRANT, SECURITY DEFINER, settlements, audit, RLS, enums) |
| `supabase/diagnostics/full_schema_integrity_check.sql` | Créé — diagnostic global (11 vérifications) |

## D. Compatibilité

| Critère | Statut |
|---------|--------|
| Reset depuis base vide | ✅ `supabase db reset` réussit complètement (40 migrations + seeds) |
| Upgrade legacy simulé | ✅ La migration corrective `20260719000000` est idempotente |
| Vues compilées | ✅ `dev_expenses_v4_view` et `dev_expenses_with_status` |
| RPC disponibles | ✅ 6 RPC V4 + 7 RPC wallet, toutes avec `SECURITY DEFINER` et `GRANT EXECUTE` |
| FK compatibles | ✅ 24 FK, toutes `uuid ↔ uuid` |
| Seeds appliqués | ✅ Creditors seedés dans migration `20260706120000` |

## E. Tests

### Backend (`unipay-api`)

```
npm run build                                    → ✅ succès
npx tsx --test src/lib/__tests__/dev-expenses-v4.test.ts
                                                 → ✅ 103 tests, 0 failures
```

### Frontend (`unipay-congo`)

```
npx vitest run                                   → ✅ 178 tests, 0 failures (2 skipped)
```

### Supabase

```
npx supabase db reset                            → ✅ Finished supabase db reset on branch main
```

### Diagnostics SQL

- `v4_migration_check.sql` : 13 requêtes — toutes passent
- `full_schema_integrity_check.sql` : 11 vérifications — toutes passent
- 24 FK vérifiées : toutes `uuid ↔ uuid`
- 6 RPC V4 : toutes `SECURITY DEFINER` + `GRANT EXECUTE` à `service_role`
- 2 vues : `dev_expenses_v4_view`, `dev_expenses_with_status`
- RLS activée sur 18/25 tables (les 7 sans RLS sont accessibles uniquement via `service_role` qui bypass RLS)

## F. Différences production

Les requêtes read-only suivantes doivent être exécutées sur la base distante pour comparer :

```sql
-- Schéma complet
SELECT table_name, column_name, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
ORDER BY table_name, ordinal_position;

-- Foreign keys
SELECT tc.table_name, kcu.column_name, ccu.table_name AS foreign_table_name,
       ccu.column_name AS foreign_column_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public';
```

**Écarts potentiels à vérifier**:
- `transactions.merchant_id` : peut être `text` en production (corrigé par migration `20260719000000`)
- `wallet_users.email` et `wallet_users.lang` : peuvent déjà exister si ajoutés manuellement
- `adi_deposit_events` : peut déjà exister si créée manuellement
- Ports Supabase locaux (55000+) différents des ports cloud (443/default)

## G. Risques restants

1. **Tables sans RLS** : `crypto_deposits`, `kyc_submissions`, `push_subscriptions`, `system_config`, `transak_orders`, `user_deposit_addresses`, `wallet_notifications` — RLS non activée. Le backend utilise `service_role` qui bypass RLS, donc pas de risque direct, mais ces tables sont accessibles via l'API PostgREST si l'API est exposée.

2. **Migration corrective sur production** : La migration `20260719000000` convertit `text → uuid`. Si des valeurs `merchant_id` invalides (non-UUID) existent en production, la conversion échouera. Il faut vérifier les données avant `db push`.

3. **Fonctions wallet sans `SET search_path`** : `wallet_debit`, `wallet_p2p`, `wallet_p2p_usdt`, `wallet_debit_usd`, `wallet_credit_usd`, `wallet_credit_usdt` n'ont pas `SET search_path = public`. Elles ne sont pas `SECURITY DEFINER` donc le risque est limité, mais pour cohérence il serait préférable de l'ajouter.

## H. Commande de déploiement proposée

```bash
# 1. Backup production database
supabase db dump --data-only --linked > backup_$(date +%Y%m%d).sql

# 2. Vérifier l'état actuel de production (read-only)
# Exécuter les requêtes de section F sur la base distante

# 3. Vérifier que merchant_id contient uniquement des UUIDs valides
# (à exécuter sur la base distante)
SELECT id, merchant_id FROM transactions
WHERE merchant_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND merchant_id IS NOT NULL;

# 4. Push migrations
npx supabase db push --linked

# 5. Exécuter les diagnostics
# supabase/diagnostics/v4_migration_check.sql
# supabase/diagnostics/full_schema_integrity_check.sql

# 6. Deploy backend
npm run build
# Deploy to Render

# 7. Deploy frontend
# Deploy to Vercel/Netlify

# 8. Smoke test
# GET /v1/admin/dev-expenses-v4/stats
# GET /v1/admin/expense-entities
# GET /v1/admin/dev-expenses-v4
# GET /v1/admin/creditors
# GET /v1/admin/quotes
# GET /v1/merchant/transactions
```

**NE PAS exécuter `db push` pendant cette task.**
