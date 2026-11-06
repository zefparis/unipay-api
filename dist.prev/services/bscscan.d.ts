import type { SupabaseClient } from '@supabase/supabase-js';
export declare function startBscPoller(supabase: SupabaseClient, logger: {
    info: (msg: string, data?: unknown) => void;
    error: (msg: string, data?: unknown) => void;
}): void;
