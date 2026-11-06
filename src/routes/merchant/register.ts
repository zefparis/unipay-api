import bcrypt from 'bcryptjs';
import type { FastifyPluginAsync } from 'fastify';
import type { SupabaseClient } from '@supabase/supabase-js';
import { sendWelcomeEmail, sendAdminNewMerchantEmail } from '../../services/email.js';

const OPERATORS = ['orange', 'airtel', 'afrimoney'] as const;

/* ── garde-fous anti-abus ──────────────────────────────────────
   Domaines email réservés (RFC 2606) ou jetables connus — refusés.
   Limite par domaine email (créations /24h) et par IP (comptes /jour,
   compteur en mémoire — mono-instance x3). */
const BLOCKED_EMAIL_DOMAINS = new Set([
  // réservés / documentation
  'example.com', 'example.net', 'example.org', 'test.com', 'invalid', 'localhost',
  // jetables courants
  'mailinator.com', 'yopmail.com', 'yopmail.fr', 'guerrillamail.com',
  '10minutemail.com', 'temp-mail.org', 'tempmail.com', 'throwawaymail.com',
  'sharklasers.com', 'getnada.com', 'dispostable.com', 'maildrop.cc',
  'fldubai.com', // domaine interne des comptes de test
]);
const MAX_PER_EMAIL_DOMAIN_24H = 3;
const MAX_PER_IP_PER_DAY = 10;

/** Inscriptions du jour (UTC) pour une IP — table registration_attempts.
 *  Erreur DB (table absente avant migration) → warn + fail open. */
async function ipRegistrationsToday(supabase: SupabaseClient, ip: string): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const { count, error } = await supabase
    .from('registration_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('ip', ip)
    .gte('created_at', `${today}T00:00:00Z`);
  if (error) return -1;
  return count ?? 0;
}

function recordIpRegistration(
  supabase: SupabaseClient, ip: string, merchantId: string,
): void {
  void supabase.from('registration_attempts')
    .insert({ ip, merchant_id: merchantId }).then(() => {});
}

interface RegisterBody {
  name: string;
  email: string;
  password: string;
  phone?: string;
  country?: string;
  company_name?: string;
  company_rccm?: string;
  company_idnat?: string;
  ref?: string;
}

const registerRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: RegisterBody }>(
    '/merchant/register',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute', keyGenerator: (req) => req.ip } },
      schema: {
        body: {
          type: 'object',
          required: ['name', 'email', 'password'],
          properties: {
            name:     { type: 'string', minLength: 2, maxLength: 128 },
            email:    { type: 'string', format: 'email' },
            password: { type: 'string', minLength: 8, maxLength: 128 },
            phone:         { type: 'string', maxLength: 32 },
            country:       { type: 'string', maxLength: 8 },
            company_name:  { type: 'string', maxLength: 256 },
            company_rccm:  { type: 'string', maxLength: 128 },
            company_idnat: { type: 'string', maxLength: 128 },
            ref:           { type: 'string', maxLength: 64 },
          },
        },
        response: {
          201: {
            type: 'object',
            properties: {
              merchant_id: { type: 'string' },
              name:        { type: 'string' },
              email:       { type: 'string' },
              api_key:     { type: ['string', 'null'] },
              message:     { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { name, email, password, phone, country, company_name, company_rccm, company_idnat, ref } = request.body;

      // Partner referral (?ref=PRT-xxx) : résout le code → partenaire
      // actif. Un ref inconnu ou inactif est ignoré, jamais bloquant.
      let referredByPartnerId: string | null = null;
      if (ref) {
        const { data: partner } = await fastify.supabase
          .from('merchants')
          .select('id')
          .eq('partner_code', ref)
          .eq('is_partner', true)
          .eq('status', 'active')
          .is('deleted_at', null)
          .maybeSingle();
        referredByPartnerId = (partner?.id as string) ?? null;
        if (referredByPartnerId) {
          fastify.log.info({ email, ref, referredByPartnerId }, 'Partner referral attached at register');
        } else {
          fastify.log.warn({ email, ref }, 'Invalid or inactive partner ref code');
        }
      }

      // 0. Garde-fous : domaine bloqué, quotas IP et domaine email
      const domain = email.split('@')[1]?.toLowerCase() ?? '';
      if (BLOCKED_EMAIL_DOMAINS.has(domain)) {
        return reply.status(400).send({ error: 'Ce domaine d’email n’est pas accepté.', statusCode: 400 });
      }
      const ipCount = await ipRegistrationsToday(fastify.supabase, request.ip);
      if (ipCount >= MAX_PER_IP_PER_DAY) {
        return reply.status(429).send({ error: 'Trop de comptes créés depuis cette adresse IP aujourd’hui.', statusCode: 429 });
      }
      if (ipCount < 0) {
        fastify.log.warn('registration_attempts indisponible — quota IP sauté (migration en attente)');
      }
      {
        const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
        const { count } = await fastify.supabase
          .from('merchants')
          .select('id', { count: 'exact', head: true })
          .ilike('email', `%@${domain}`)
          .gte('created_at', cutoff);
        if ((count ?? 0) >= MAX_PER_EMAIL_DOMAIN_24H) {
          return reply.status(429).send({ error: 'Trop de comptes créés récemment avec ce domaine d’email.', statusCode: 429 });
        }
      }

      // 1. Check email uniqueness in merchants table
      const { data: existing } = await fastify.supabase
        .from('merchants')
        .select('id')
        .eq('email', email)
        .maybeSingle();

      if (existing) {
        return reply.status(409).send({ error: 'Email already registered', statusCode: 409 });
      }

      // 2. Hash password
      const passwordHash = await bcrypt.hash(password, 12);

      // 3. Insert merchant
      const { data: merchant, error: merchantError } = await fastify.supabase
        .from('merchants')
        .insert({
          name,
          email,
          password_hash:  passwordHash,
          phone:          phone         ?? null,
          country:        country       ?? 'CD',
          status:         'active',
          access_status:  'kyc_required',   // conformité : aucune clé API avant validation du dossier
          kyc_status:     'pending',
          company_name:   company_name  ?? null,
          company_rccm:   company_rccm  ?? null,
          company_idnat:  company_idnat ?? null,
          referred_by_partner_id: referredByPartnerId,
        })
        .select('id')
        .single();

      if (merchantError || !merchant) {
        fastify.log.error({ err: merchantError, email }, 'Merchant insert failed');
        return reply.status(500).send({ error: 'Registration failed', statusCode: 500 });
      }

      const merchantId: string = merchant.id as string;
      recordIpRegistration(fastify.supabase, request.ip, merchantId);

      // 4. Create one operators row per operator
      const operatorRows = OPERATORS.map((op) => ({
        merchant_id:  merchantId,
        operator:     op,
        balance_cdf:  0,
        status:       'active',
      }));

      const { error: opError } = await fastify.supabase
        .from('operators')
        .insert(operatorRows);

      if (opError) {
        fastify.log.error({ err: opError, merchantId }, 'Operator rows creation failed');
      }

      // 5. Pas de clé API : le compte démarre en access_status='kyc_required',
      // la clé (sandbox puis live) sera émise par un admin après validation
      // des 3 documents obligatoires.

      fastify.log.info({ merchantId, email }, 'Merchant registered');

      // Fire welcome email — non-blocking (M7: no API key in email)
      sendWelcomeEmail(email, name).catch((err: unknown) => {
        fastify.log.error({ err, email }, 'Welcome email failed');
      });

      // Notify admin of new registration — non-blocking
      sendAdminNewMerchantEmail(name, email, company_name ?? '').catch((err: unknown) => {
        fastify.log.error({ err, email }, 'Admin notification email failed');
      });

      return reply.status(201).send({
        merchant_id: merchantId,
        name,
        email,
        api_key: null,
        message: 'Compte créé. Envoyez vos documents KYC depuis votre espace marchand pour activer votre accès.',
      });
    },
  );
};

export default registerRoute;
