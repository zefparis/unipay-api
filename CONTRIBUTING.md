# CONTRIBUTING — UniPay Congo API

## SECURITY DEFINER Functions — Mandatory REVOKE

### The rule

**Every** `SECURITY DEFINER` function in a SQL migration **MUST** be followed
by an explicit `REVOKE ALL ON FUNCTION ... FROM PUBLIC;` in the **same
migration file**. Never assume a REVOKE from a previous migration will
persist — PostgreSQL resets function ACLs to default (EXECUTE to PUBLIC)
on `CREATE OR REPLACE FUNCTION`.

### Why

PostgreSQL grants `EXECUTE` to `PUBLIC` by default on new functions. In a
Supabase context, `PUBLIC` includes the `anon` and `authenticated` roles,
which are exposed via the PostgREST API. A `SECURITY DEFINER` function
executable by `anon`/`authenticated` can be called directly via
`https://<project>.supabase.co/rest/v1/rpc/<function_name>` — completely
bypassing the Fastify backend and all its validation, authentication, and
authorization checks.

### The CREATE OR REPLACE trap

`CREATE OR REPLACE FUNCTION` **resets the ACL** to the default (EXECUTE to
PUBLIC). If migration A creates a function with REVOKE, and migration B
later uses `CREATE OR REPLACE FUNCTION` on the same function without
re-applying REVOKE, the function is silently re-exposed — even though
migration A did everything correctly.

**Always re-apply REVOKE after every `CREATE OR REPLACE FUNCTION`**, even
if you think the function was already revoked.

### Correct pattern

```sql
CREATE OR REPLACE FUNCTION public.wallet_credit_cdf(
  p_user_id UUID,
  p_amount NUMERIC
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- ... function body ...
END $$;

-- MANDATORY: revoke from PUBLIC immediately after the function definition
REVOKE ALL ON FUNCTION public.wallet_credit_cdf(UUID, NUMERIC) FROM PUBLIC;

-- Optional: grant explicitly to service_role (the backend's role)
GRANT EXECUTE ON FUNCTION public.wallet_credit_cdf(UUID, NUMERIC) TO service_role;
```

### Guard tests

Two guard mechanisms are in place:

1. **Static analysis test** (`src/lib/__tests__/security-definer-grants.test.ts`):
   Scans all migration files and fails if a SECURITY DEFINER financial
   function lacks REVOKE in its migration, or if a `CREATE OR REPLACE
   FUNCTION` re-exposes a previously-revoked function.

2. **Live database guard** (`supabase/tests/20260912000000_security_definer_grants_guard.sql`):
   Queries `pg_proc` and `has_function_privilege()` to check actual grants
   in the live database. Run after migrations:
   ```bash
   psql "$DATABASE_URL" -f supabase/tests/20260912000000_security_definer_grants_guard.sql
   ```

### Financial function whitelist

The guard tests check functions whose names match these prefixes:
- `wallet_` (balance operations)
- `process_merchant_` (settlement processing)
- `process_wallet_` (provider callbacks)
- `resolve_` (onchain resolution, migration reviews)
- `mark_` (status transitions)
- `begin_` (onchain operation initiation)
- `reject_` (settlement rejection)

If you add a new SECURITY DEFINER function with a different prefix that
handles financial data, add the prefix to the whitelist in both guard tests.
