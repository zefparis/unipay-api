import { type SupabaseClient } from '@supabase/supabase-js';
import type { FastifyPluginAsync } from 'fastify';
declare module 'fastify' {
    interface FastifyInstance {
        supabase: SupabaseClient;
    }
}
declare const _default: FastifyPluginAsync;
export default _default;
