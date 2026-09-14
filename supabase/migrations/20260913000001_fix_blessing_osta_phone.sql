-- ─────────────────────────────────────────────────────────────────────────────
-- Correction : Blessing Osta — numéro de téléphone mal formaté
--
-- Bug : +243243853315944 (indicatif 243 en double)
-- Correction : +243853315944 (retire uniquement le second "243" en double)
--
-- Wallet ID partiel fourni : 931efa4e...59a2d
-- Ce script recherche l'utilisateur par phone actuel (= +243243853315944)
-- pour ne pas dépendre de l'ID tronqué.
--
-- Sécurité :
--   - Transaction atomique (BEGIN/COMMIT)
--   - Vérifie que l'ancien phone correspond exactement avant de corriger
--   - Vérifie que le nouveau phone n'existe pas déjà chez un autre user
--   - Log l'action dans admin_action_log (old_phone + new_phone)
--
-- Exécuter sur Supabase (SQL Editor ou psql) :
--   psql "$DATABASE_URL" -f supabase/migrations/20260913000001_fix_blessing_osta_phone.sql
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- 1. Vérifier que l'utilisateur existe avec l'ancien phone
DO $$
DECLARE
  v_user_id uuid;
  v_old_phone text := '+243243853315944';
  v_new_phone text := '+243853315944';
  v_conflict_count int;
BEGIN
  SELECT id INTO v_user_id FROM wallet_users WHERE phone = v_old_phone;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Aucun wallet user trouvé avec phone = %. Soit le numéro a déjà été corrigé, soit le numéro en base est différent.', v_old_phone;
  END IF;

  -- Vérifier l'ID partiel fourni (931efa4e...59a2d)
  IF v_user_id::text NOT LIKE '931efa4e%59a2d' THEN
    RAISE EXCEPTION 'L''ID du wallet user trouvé (%) ne correspond pas au pattern attendu (931efa4e...59a2d). Abord pour sécurité.', v_user_id;
  END IF;

  -- Vérifier que le nouveau phone n'existe pas déjà
  SELECT COUNT(*) INTO v_conflict_count FROM wallet_users WHERE phone = v_new_phone AND id != v_user_id;
  IF v_conflict_count > 0 THEN
    RAISE EXCEPTION 'Le nouveau phone % existe déjà chez un autre wallet user. Abord.', v_new_phone;
  END IF;

  RAISE NOTICE 'Wallet user trouvé : ID=%, ancien phone=% → nouveau phone=%', v_user_id, v_old_phone, v_new_phone;
END $$;

-- 2. Corriger le phone
UPDATE wallet_users
SET phone = '+243853315944',
    updated_at = now()
WHERE phone = '+243243853315944'
  AND id::text LIKE '931efa4e%59a2d';

-- 3. Logger l'action dans admin_action_log
INSERT INTO admin_action_log (action, resource_type, resource_id, request_summary, actor)
SELECT
  'wallet_user.correct_phone',
  'wallet_user',
  id,
  jsonb_build_object(
    'old_phone', '+243243853315944',
    'new_phone', '+243853315944',
    'reason', 'Double indicatif 243 — correction via script SQL (bug de saisie)',
    'source', 'sql_migration_20260913000001'
  ),
  'admin'
FROM wallet_users
WHERE phone = '+243853315944'
  AND id::text LIKE '931efa4e%59a2d';

-- 4. Vérification finale
SELECT id, phone, full_name, updated_at
FROM wallet_users
WHERE id::text LIKE '931efa4e%59a2d';

COMMIT;
