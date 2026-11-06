import type { SupabaseClient } from '@supabase/supabase-js';
interface ReconciliationLogger {
    info: (data: unknown, message?: string) => void;
    warn: (data: unknown, message?: string) => void;
    error: (data: unknown, message?: string) => void;
}
export declare function reconcilePendingOnchainOperations(supabase: SupabaseClient, log: ReconciliationLogger): Promise<void>;
export declare function startOnchainReconciler(supabase: SupabaseClient, log: ReconciliationLogger, intervalMs?: number): void;
export {};
