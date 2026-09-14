-- ══════════════════════════════════════════════════════════════
-- Migration: RLS performance fixes (auth_rls_initplan + multiple_permissive_policies)
--
-- Fixes two Supabase linter PERFORMANCE warnings without changing
-- authorization behavior (no one gains or loses access):
--
-- 1. auth_rls_initplan on whitelisted_contract_destinations:
--    Replace `auth.role()` with `(select auth.role())` so the value is
--    cached once per query (init plan) instead of re-evaluated per row.
--
-- 2. multiple_permissive_policies on support_conversations:
--    Fuse `merchant_isolation` + `wallet_user_isolation` (two permissive
--    FOR ALL policies) into a single FOR ALL policy with an OR between
--    the two conditions. Same access, one policy evaluation per query.
--
-- 3. multiple_permissive_policies on support_messages:
--    Fuse `via_conversation` + `via_wallet_conversation` (two permissive
--    FOR ALL policies) into a single FOR ALL policy with an OR between
--    the two EXISTS subqueries. Same access, one policy evaluation.
--
-- All volatile functions (auth.role(), current_setting()) are wrapped in
-- (select ...) so Postgres evaluates them once per query (init plan)
-- instead of once per row. This fixes auth_rls_initplan on every policy.
-- The `current_setting(name, true)` NULL-on-missing behavior is preserved:
-- (select current_setting(name, true)) returns NULL if the setting is
-- absent, exactly like the unwrapped call. The ::uuid cast is applied
-- outside the subselect, so NULL::uuid = NULL (no error).
-- ══════════════════════════════════════════════════════════════

-- ─── 1. whitelisted_contract_destinations: auth.role() → (select auth.role()) ───

DROP POLICY IF EXISTS whitelisted_contract_destinations_service_role
  ON public.whitelisted_contract_destinations;

CREATE POLICY whitelisted_contract_destinations_service_role
  ON public.whitelisted_contract_destinations
  FOR ALL
  USING ((select auth.role()) = 'service_role')
  WITH CHECK ((select auth.role()) = 'service_role');

-- ─── 2. support_conversations: fuse merchant + wallet policies ───────────────
-- Before: two permissive FOR ALL policies (OR'd by Postgres → 2 evaluations)
-- After:  one FOR ALL policy with OR (1 evaluation)
--
-- Condition A (merchant): merchant_id = current_setting('app.current_merchant_id')
-- Condition B (wallet):   wallet_user_id = current_setting('app.current_wallet_user_id')
-- Access granted if A OR B. Exactly the same as the two-policy OR.

DROP POLICY IF EXISTS support_conversations_merchant_isolation
  ON public.support_conversations;

DROP POLICY IF EXISTS support_conversations_wallet_user_isolation
  ON public.support_conversations;

CREATE POLICY support_conversations_owner_isolation
  ON public.support_conversations
  FOR ALL
  USING (
    merchant_id = (select current_setting('app.current_merchant_id', true))::uuid
    OR
    wallet_user_id = (select current_setting('app.current_wallet_user_id', true))::uuid
  );

-- ─── 3. support_messages: fuse merchant + wallet conversation policies ───────
-- Before: two permissive FOR ALL policies, each with an EXISTS subquery
-- After:  one FOR ALL policy with OR between the two EXISTS subqueries

DROP POLICY IF EXISTS support_messages_via_conversation
  ON public.support_messages;

DROP POLICY IF EXISTS support_messages_via_wallet_conversation
  ON public.support_messages;

CREATE POLICY support_messages_owner_isolation
  ON public.support_messages
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.support_conversations sc
      WHERE sc.id = support_messages.conversation_id
        AND sc.merchant_id = (select current_setting('app.current_merchant_id', true))::uuid
    )
    OR
    EXISTS (
      SELECT 1 FROM public.support_conversations sc
      WHERE sc.id = support_messages.conversation_id
        AND sc.wallet_user_id = (select current_setting('app.current_wallet_user_id', true))::uuid
    )
  );
