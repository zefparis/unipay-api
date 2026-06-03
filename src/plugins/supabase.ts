import fp from 'fastify-plugin';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { FastifyPluginAsync } from 'fastify';
import { env } from '../config/env';

declare module 'fastify' {
  interface FastifyInstance {
    supabase: SupabaseClient;
  }
}

const supabasePlugin: FastifyPluginAsync = async (fastify) => {
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });

  fastify.decorate('supabase', client);
  fastify.log.info('Supabase client registered');
};

export default fp(supabasePlugin, { name: 'supabase-plugin' });
