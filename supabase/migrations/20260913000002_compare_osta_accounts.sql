-- ─────────────────────────────────────────────────────────────────────────────
-- Diagnostic : comparaison des deux comptes wallet pour Blessing Osta
--
-- Compte A (mal formaté) : phone = +243243853315944
-- Compte B (correct)    : phone = +243853315944
--
-- Le client a recréé un second compte après avoir raté son premier numéro.
-- Ce script récupère TOUT l'état des deux comptes pour décider de la marche à suivre.
--
-- AUCUNE modification — lecture seule.
-- Compatible avec le SQL Editor Supabase (pas de commandes psql \echo).
-- Les jointures sur tables optionnelles sont protégées par to_regclass().
-- ─────────────────────────────────────────────────────────────────────────────

-- ═══════════════════════════════════════════════════════════════════════════
-- VUE 1 : Infos complètes des deux comptes
-- ═══════════════════════════════════════════════════════════════════════════
SELECT
  id,
  phone,
  full_name,
  email,
  kyc_level,
  is_verified,
  is_active,
  balance_cdf,
  cglt_balance,
  usdt_balance,
  usd_balance,
  blockchain_address,
  cdp_wallet_address,
  lang,
  created_at,
  updated_at,
  kyc_submitted_at,
  CASE
    WHEN phone = '+243243853315944' THEN 'A (mal formaté)'
    WHEN phone = '+243853315944'    THEN 'B (correct)'
  END AS compte
FROM wallet_users
WHERE phone IN ('+243243853315944', '+243853315944')
ORDER BY created_at;

-- ═══════════════════════════════════════════════════════════════════════════
-- VUE 2 : Nombre de transactions par compte + dernière activité
-- ═══════════════════════════════════════════════════════════════════════════
SELECT
  CASE
    WHEN wu.phone = '+243243853315944' THEN 'A (mal formaté)'
    WHEN wu.phone = '+243853315944'    THEN 'B (correct)'
  END AS compte,
  COUNT(t.id) AS nb_transactions,
  MAX(t.created_at) AS derniere_activite,
  SUM(CASE WHEN t.direction = 'collect' THEN t.amount ELSE 0 END) AS total_collecte,
  SUM(CASE WHEN t.direction = 'payout' THEN t.amount ELSE 0 END) AS total_paiement,
  SUM(CASE WHEN t.direction = 'p2p' THEN t.amount ELSE 0 END) AS total_p2p,
  SUM(CASE WHEN t.direction = 'p2p_usdt' THEN t.amount ELSE 0 END) AS total_p2p_usdt,
  SUM(CASE WHEN t.direction = 'swap' THEN t.amount ELSE 0 END) AS total_swap
FROM wallet_users wu
LEFT JOIN transactions t ON t.wallet_user_id = wu.id
WHERE wu.phone IN ('+243243853315944', '+243853315944')
GROUP BY wu.id, wu.phone
ORDER BY wu.created_at;

-- ═══════════════════════════════════════════════════════════════════════════
-- VUE 3 : Détail des transactions (40 plus récentes, tous comptes confondus)
-- ═══════════════════════════════════════════════════════════════════════════
SELECT
  CASE
    WHEN wu.phone = '+243243853315944' THEN 'A'
    WHEN wu.phone = '+243853315944'    THEN 'B'
  END AS compte,
  t.id,
  t.direction,
  t.operator,
  t.amount,
  t.currency,
  t.status,
  t.reference,
  t.created_at
FROM transactions t
JOIN wallet_users wu ON t.wallet_user_id = wu.id
WHERE wu.phone IN ('+243243853315944', '+243853315944')
ORDER BY t.created_at DESC
LIMIT 40;

-- ═══════════════════════════════════════════════════════════════════════════
-- VUE 4 : KYC submissions par compte
-- ═══════════════════════════════════════════════════════════════════════════
SELECT
  CASE
    WHEN wu.phone = '+243243853315944' THEN 'A (mal formaté)'
    WHEN wu.phone = '+243853315944'    THEN 'B (correct)'
  END AS compte,
  ks.id,
  ks.status,
  ks.doc_type,
  ks.full_name AS kyc_full_name,
  ks.submitted_at,
  ks.reviewed_at,
  ks.reviewer_note
FROM kyc_submissions ks
JOIN wallet_users wu ON ks.wallet_user_id = wu.id
WHERE wu.phone IN ('+243243853315944', '+243853315944')
ORDER BY ks.submitted_at DESC;

-- ═══════════════════════════════════════════════════════════════════════════
-- VUE 5 : Push subscriptions + notifications par compte
-- (uniquement si les tables existent en production)
-- ═══════════════════════════════════════════════════════════════════════════
SELECT
  CASE
    WHEN wu.phone = '+243243853315944' THEN 'A (mal formaté)'
    WHEN wu.phone = '+243853315944'    THEN 'B (correct)'
  END AS compte,
  COUNT(DISTINCT ps.id) AS nb_push_subscriptions,
  COUNT(DISTINCT wn.id) AS nb_notifications,
  MAX(wn.created_at) AS derniere_notif
FROM wallet_users wu
LEFT JOIN push_subscriptions ps ON ps.user_id = wu.id
  AND to_regclass('public.push_subscriptions') IS NOT NULL
LEFT JOIN wallet_notifications wn ON wn.user_id = wu.id
  AND to_regclass('public.wallet_notifications') IS NOT NULL
WHERE wu.phone IN ('+243243853315944', '+243853315944')
GROUP BY wu.id, wu.phone;

-- ═══════════════════════════════════════════════════════════════════════════
-- VUE 6 : Transactions on-chain (wCGLT) par compte
-- (uniquement si la table existe en production)
-- ═══════════════════════════════════════════════════════════════════════════
SELECT
  CASE
    WHEN wu.phone = '+243243853315944' THEN 'A (mal formaté)'
    WHEN wu.phone = '+243853315944'    THEN 'B (correct)'
  END AS compte,
  COUNT(oc.id) AS nb_onchain_ops,
  SUM(oc.amount_onchain) AS total_onchain,
  MAX(oc.created_at) AS derniere_onchain
FROM wallet_users wu
LEFT JOIN onchain_operations oc ON oc.wallet_user_id = wu.id
WHERE wu.phone IN ('+243243853315944', '+243853315944')
  AND to_regclass('public.onchain_operations') IS NOT NULL
GROUP BY wu.id, wu.phone;

-- ═══════════════════════════════════════════════════════════════════════════
-- VUE 7 : Résumé comparatif (une ligne par compte)
-- ═══════════════════════════════════════════════════════════════════════════
SELECT
  CASE
    WHEN wu.phone = '+243243853315944' THEN 'A (mal formaté)'
    WHEN wu.phone = '+243853315944'    THEN 'B (correct)'
  END AS compte,
  wu.id,
  wu.phone,
  wu.full_name,
  wu.email,
  wu.kyc_level,
  wu.is_active,
  wu.balance_cdf,
  wu.cglt_balance,
  wu.usdt_balance,
  wu.usd_balance,
  wu.created_at,
  wu.updated_at,
  COALESCE(tx_stats.nb_tx, 0) AS nb_transactions,
  COALESCE(tx_stats.derniere_activite, wu.created_at) AS derniere_activite,
  COALESCE(tx_stats.total_volume, 0) AS total_volume_transactions
FROM wallet_users wu
LEFT JOIN (
  SELECT
    wallet_user_id,
    COUNT(*) AS nb_tx,
    MAX(created_at) AS derniere_activite,
    SUM(amount) AS total_volume
  FROM transactions
  GROUP BY wallet_user_id
) tx_stats ON tx_stats.wallet_user_id = wu.id
WHERE wu.phone IN ('+243243853315944', '+243853315944')
ORDER BY wu.created_at;
