-- Add missing RLS policy on withdrawal_requests.
-- RLS was enabled in 20260612000000_withdrawal_requests.sql but no policy
-- was created, which would block access for any non-service-role queries.
-- The backend uses the service_role (which bypasses RLS), so this was not
-- blocking in practice, but we add the policy for consistency and safety.

CREATE POLICY "service_role_all" ON withdrawal_requests
  FOR ALL TO service_role USING (true) WITH CHECK (true);
