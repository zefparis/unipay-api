import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Log a sensitive admin action to the admin_action_log table.
 *
 * This is a fire-and-forget operation: logging failures are logged
 * to the fastify logger but do NOT block the admin action itself.
 * The action has already been performed by the time this is called.
 *
 * @param supabase - The Supabase client from fastify.supabase
 * @param action - Short identifier, e.g. 'merchant.suspend'
 * @param resourceType - e.g. 'merchant', 'wallet_user'
 * @param resourceId - UUID of the affected resource (optional)
 * @param requestSummary - Safe summary of request body (NEVER secrets/passwords)
 * @param log - Fastify logger for error logging
 */
export async function logAdminAction(
  supabase: SupabaseClient,
  action: string,
  resourceType: string,
  resourceId: string | null | undefined,
  requestSummary: Record<string, unknown>,
  log?: { error: (obj: Record<string, unknown>, msg: string) => void },
): Promise<void> {
  try {
    const { error } = await supabase
      .from('admin_action_log')
      .insert({
        action,
        resource_type: resourceType,
        resource_id: resourceId ?? null,
        request_summary: requestSummary,
        actor: 'admin',
      });

    if (error && log) {
      log.error({ err: error, action, resourceType, resourceId }, '[admin-action-log] failed to insert audit record');
    }
  } catch (err) {
    if (log) {
      log.error({ err, action, resourceType, resourceId }, '[admin-action-log] exception during audit logging');
    }
  }
}
