-- ─────────────────────────────────────────────────────────────────────────────
-- Diagnostic : wallet users avec numéro de téléphone mal formaté
--
-- Détecte :
--   1. Les phones contenant "243243" (double indicatif DRC — le bug connu)
--   2. Les phones dont la longueur est anormale (> 13 caractères, soit +243 + 10+ chiffres)
--   3. Les phones ne respectant pas le format strict +243 + 9 chiffres
--
-- Exécuter sur Supabase (SQL Editor ou psql) :
--   psql "$DATABASE_URL" -f supabase/migrations/20260913000000_phone_audit.sql
--
-- AUCUNE modification n'est faite — lecture seule.
-- ─────────────────────────────────────────────────────────────────────────────

-- Vue 1 : Users avec "243243" dans le phone (double indicatif)
SELECT
  id,
  phone,
  full_name,
  is_active,
  created_at
FROM wallet_users
WHERE phone LIKE '%243243%'
ORDER BY created_at DESC;

-- Vue 2 : Users avec longueur anormale (> 13 caractères : +243 + 10+ chiffres)
SELECT
  id,
  phone,
  full_name,
  is_active,
  created_at,
  LENGTH(phone) AS phone_length
FROM wallet_users
WHERE LENGTH(phone) > 13
ORDER BY phone_length DESC;

-- Vue 3 : Tous les phones ne respectant PAS le format strict +243 + 9 chiffres
-- (catch-all pour tout format aberrant non couvert par les vues 1 et 2)
SELECT
  id,
  phone,
  full_name,
  is_active,
  created_at,
  LENGTH(phone) AS phone_length
FROM wallet_users
WHERE phone !~ '^\+243[0-9]{9}$'
ORDER BY created_at DESC;

-- Vue 4 : Résumé — compte par catégorie de problème
SELECT
  'double_243' AS problem,
  COUNT(*) AS affected_count
FROM wallet_users WHERE phone LIKE '%243243%'
UNION ALL
SELECT
  'length_gt_13',
  COUNT(*)
FROM wallet_users WHERE LENGTH(phone) > 13
UNION ALL
SELECT
  'not_strict_format',
  COUNT(*)
FROM wallet_users WHERE phone !~ '^\+243[0-9]{9}$';
