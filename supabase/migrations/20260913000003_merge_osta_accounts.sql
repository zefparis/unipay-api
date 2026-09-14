-- ─────────────────────────────────────────────────────────────────────────────
-- Fusion : deux comptes wallet pour Blessing Osta
--
-- Contexte :
--   Le client a créé deux comptes suite au bug du double indicatif 243.
--   - Compte A (mal formaté) : phone = +243243853315944, full_name = "Blessing osta",
--                            email = "blessingosta@gmail.com"
--   - Compte B (correct)     : phone = +243853315944, full_name = null, email = null
--
--   La migration précédente (20260913000001) tentait de corriger le phone du
--   compte A, mais elle échoue car le phone cible (+243853315944) existe déjà
--   sur le compte B. Ce script fusionne donc vers B.
--
-- Action :
--   1. Copier full_name et email du compte A vers le compte B (si B est vide).
--   2. Désactiver le compte A (is_active = false).
--   3. Logger l'action dans admin_action_log.
--
-- Sécurité :
--   - Transaction atomique (BEGIN/COMMIT)
--   - Vérifie les IDs exacts avant toute modification
--   - Vérifie que les deux comptes existent
--   - Vérifie qu'aucun des deux comptes n'a de transactions (sécurité supplémentaire)
--   - Ne copie le profil que si B n'a pas déjà ces valeurs
--
-- Exécuter sur Supabase (SQL Editor ou psql) :
--   psql "$DATABASE_URL" -f supabase/migrations/20260913000003_merge_osta_accounts.sql
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- 1. Vérifications de sécurité
DO $$
DECLARE
  v_a_id uuid;
  v_b_id uuid;
  v_a_phone text := '+243243853315944';
  v_b_phone text := '+243853315944';
  v_a_expected_id text := '931efa4e-fc3c-4462-b345-412b35259a2d';
  v_b_expected_id text := '50afb674-c74a-4add-9a8d-18c9f23fd11a';
  v_tx_count int;
BEGIN
  -- Récupérer les deux comptes
  SELECT id INTO v_a_id FROM wallet_users WHERE phone = v_a_phone;
  SELECT id INTO v_b_id FROM wallet_users WHERE phone = v_b_phone;

  IF v_a_id IS NULL THEN
    RAISE EXCEPTION 'Compte A introuvable (phone = %). Peut-être déjà corrigé ?', v_a_phone;
  END IF;

  IF v_b_id IS NULL THEN
    RAISE EXCEPTION 'Compte B introuvable (phone = %).', v_b_phone;
  END IF;

  -- Vérifier les IDs exacts
  IF v_a_id::text != v_a_expected_id THEN
    RAISE EXCEPTION 'ID du compte A (%) ne correspond pas à l''ID attendu (%). Abord.', v_a_id, v_a_expected_id;
  END IF;

  IF v_b_id::text != v_b_expected_id THEN
    RAISE EXCEPTION 'ID du compte B (%) ne correspond pas à l''ID attendu (%). Abord.', v_b_id, v_b_expected_id;
  END IF;

  -- Vérifier qu'aucun des deux comptes n'a de transactions
  SELECT COUNT(*) INTO v_tx_count
  FROM transactions t
  WHERE t.wallet_user_id IN (v_a_id, v_b_id);

  IF v_tx_count > 0 THEN
    RAISE EXCEPTION 'Les comptes ont % transaction(s). Fusion annulée — vérifier manuellement avant de continuer.', v_tx_count;
  END IF;

  RAISE NOTICE 'Compte A : ID=%, phone=%, full_name=%', v_a_id, v_a_phone, (SELECT full_name FROM wallet_users WHERE id = v_a_id);
  RAISE NOTICE 'Compte B : ID=%, phone=%, full_name=%', v_b_id, v_b_phone, (SELECT full_name FROM wallet_users WHERE id = v_b_id);
  RAISE NOTICE 'Aucune transaction trouvée. Fusion autorisée.';
END $$;

-- 2. Copier le profil du compte A vers le compte B (uniquement si B est vide)
UPDATE wallet_users
SET
  full_name = COALESCE(full_name, (SELECT full_name FROM wallet_users WHERE phone = '+243243853315944')),
  email     = COALESCE(email,     (SELECT email     FROM wallet_users WHERE phone = '+243243853315944')),
  updated_at = now()
WHERE phone = '+243853315944'
  AND id::text = '50afb674-c74a-4add-9a8d-18c9f23fd11a'
  AND (full_name IS NULL OR email IS NULL);

-- 3. Désactiver le compte A
UPDATE wallet_users
SET
  is_active = false,
  updated_at = now()
WHERE phone = '+243243853315944'
  AND id::text = '931efa4e-fc3c-4462-b345-412b35259a2d';

-- 4. Logger l'action dans admin_action_log
INSERT INTO admin_action_log (action, resource_type, resource_id, request_summary, actor)
VALUES (
  'wallet_user.merge_duplicate',
  'wallet_user',
  '50afb674-c74a-4add-9a8d-18c9f23fd11a'::uuid,
  jsonb_build_object(
    'reason', 'Fusion de deux comptes dupliqués (bug double indicatif 243)',
    'kept_account', jsonb_build_object(
      'id', '50afb674-c74a-4add-9a8d-18c9f23fd11a',
      'phone', '+243853315944',
      'description', 'Compte B (correct) — conservé et enrichi avec le profil du compte A'
    ),
    'deactivated_account', jsonb_build_object(
      'id', '931efa4e-fc3c-4462-b345-412b35259a2d',
      'phone', '+243243853315944',
      'description', 'Compte A (mal formaté) — désactivé'
    ),
    'copied_fields', jsonb_build_array('full_name', 'email'),
    'source', 'sql_migration_20260913000003'
  ),
  'admin'
);

-- 5. Vérification finale — état des deux comptes
SELECT
  CASE
    WHEN phone = '+243243853315944' THEN 'A (désactivé)'
    WHEN phone = '+243853315944'    THEN 'B (actif, fusionné)'
  END AS compte,
  id,
  phone,
  full_name,
  email,
  is_active,
  updated_at
FROM wallet_users
WHERE phone IN ('+243243853315944', '+243853315944')
ORDER BY created_at;

COMMIT;
