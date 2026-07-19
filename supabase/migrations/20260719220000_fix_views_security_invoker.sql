-- ════════════════════════════════════════════════════════════════════════════
-- Migration: 20260719220000_fix_views_security_invoker.sql
-- Purpose  : Set SECURITY INVOKER on views flagged by Supabase database linter.
--            SECURITY DEFINER views bypass RLS and enforce the creator's
--            permissions, which is a security risk for client-facing views.
-- ════════════════════════════════════════════════════════════════════════════

ALTER VIEW public.dev_expenses_with_status SET (security_invoker = true);
ALTER VIEW public.dev_expenses_v4_view SET (security_invoker = true);
