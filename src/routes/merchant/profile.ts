import bcrypt from 'bcryptjs';
import type { FastifyPluginAsync } from 'fastify';
import { requireActiveMerchant, merchantIdFromRequest } from '../../lib/merchant-auth.js';
import { isValidDrcPhone } from '../../lib/phone-normalization.js';
import { sendSecurityNotificationEmail } from '../../services/email.js';

/**
 * Merchant profile routes — self-service account management.
 *
 *   GET   /merchant/profile              — read own profile
 *   PATCH /merchant/profile              — update name, phone, company_name
 *   POST  /merchant/profile/change-email — change login email (requires current_password)
 *   POST  /merchant/profile/change-password — change password (requires current_password)
 *
 * Security:
 *   - All routes use requireActiveMerchant() → JWT-based, merchant_id from token only
 *   - No merchant_id in request bodies (isolation enforced by JWT)
 *   - change-email and change-password require current_password verification
 *   - Rate limited: 5 attempts/hour per merchant_id
 */
const profileRoute: FastifyPluginAsync = async (fastify) => {
  // ── GET /merchant/profile ────────────────────────────────────
  fastify.get(
    '/merchant/profile',
    async (request, reply) => {
      const auth = await requireActiveMerchant(request, fastify.supabase);
      if (!auth.ok) return reply.status(auth.status).send(auth.error);

      const merchantId = auth.payload.merchant_id;

      const { data, error } = await fastify.supabase
        .from('merchants')
        .select('id, name, email, phone, country, company_name, company_rccm, company_idnat, kyc_status, mode, created_at')
        .eq('id', merchantId)
        .maybeSingle();

      if (error || !data) {
        return reply.status(404).send({ error: 'Merchant not found', statusCode: 404 });
      }

      // NEVER expose password_hash
      return reply.send({
        id: data.id,
        name: data.name,
        email: data.email,
        phone: data.phone,
        country: data.country,
        company_name: data.company_name,
        company_rccm: data.company_rccm,
        company_idnat: data.company_idnat,
        kyc_status: data.kyc_status,
        mode: data.mode,
        created_at: data.created_at,
      });
    },
  );

  // ── PATCH /merchant/profile ──────────────────────────────────
  fastify.patch<{ Body: PatchProfileBody }>(
    '/merchant/profile',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            name:         { type: 'string', minLength: 2, maxLength: 128 },
            phone:        { type: 'string', maxLength: 32 },
            company_name: { type: 'string', maxLength: 256 },
          },
        },
      },
    },
    async (request, reply) => {
      const auth = await requireActiveMerchant(request, fastify.supabase);
      if (!auth.ok) return reply.status(auth.status).send(auth.error);

      const merchantId = auth.payload.merchant_id;
      const { name, phone, company_name } = request.body;

      // Fetch current merchant to check KYC status
      const { data: current, error: fetchErr } = await fastify.supabase
        .from('merchants')
        .select('kyc_status')
        .eq('id', merchantId)
        .maybeSingle();

      if (fetchErr || !current) {
        return reply.status(404).send({ error: 'Merchant not found', statusCode: 404 });
      }

      // Build update — only allow provided fields
      const updates: Record<string, unknown> = {};
      if (name !== undefined) updates.name = name;
      if (company_name !== undefined) updates.company_name = company_name;

      if (phone !== undefined) {
        if (phone && !isValidDrcPhone(phone)) {
          return reply.status(400).send({ error: 'Invalid phone number format', statusCode: 400 });
        }
        updates.phone = phone || null;
      }

      // Lock company_name if KYC approved (changing it would invalidate KYC)
      if (current.kyc_status === 'approved' && company_name !== undefined) {
        return reply.status(403).send({
          error: 'Company name cannot be changed after KYC approval. Contact support.',
          statusCode: 403,
        });
      }

      if (Object.keys(updates).length === 0) {
        return reply.status(400).send({ error: 'No fields to update', statusCode: 400 });
      }

      const { data: updated, error: updateErr } = await fastify.supabase
        .from('merchants')
        .update(updates)
        .eq('id', merchantId)
        .select('id, name, email, phone, country, company_name, company_rccm, company_idnat, kyc_status, mode, created_at')
        .maybeSingle();

      if (updateErr || !updated) {
        return reply.status(500).send({ error: 'Failed to update profile', statusCode: 500 });
      }

      return reply.send({
        id: updated.id,
        name: updated.name,
        email: updated.email,
        phone: updated.phone,
        country: updated.country,
        company_name: updated.company_name,
        company_rccm: updated.company_rccm,
        company_idnat: updated.company_idnat,
        kyc_status: updated.kyc_status,
        mode: updated.mode,
        created_at: updated.created_at,
      });
    },
  );

  // ── POST /merchant/profile/change-email ──────────────────────
  fastify.post<{ Body: ChangeEmailBody }>(
    '/merchant/profile/change-email',
    {
      schema: {
        body: {
          type: 'object',
          required: ['new_email', 'current_password'],
          properties: {
            new_email:        { type: 'string', format: 'email' },
            current_password: { type: 'string', minLength: 1 },
          },
        },
      },
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 hour',
          keyGenerator: (req) => merchantIdFromRequest(req) ?? req.ip,
        },
      },
    },
    async (request, reply) => {
      const auth = await requireActiveMerchant(request, fastify.supabase);
      if (!auth.ok) return reply.status(auth.status).send(auth.error);

      const merchantId = auth.payload.merchant_id;
      const { new_email, current_password } = request.body;

      // Fetch merchant with password hash
      const { data: merchant, error: fetchErr } = await fastify.supabase
        .from('merchants')
        .select('id, email, password_hash, name')
        .eq('id', merchantId)
        .maybeSingle();

      if (fetchErr || !merchant) {
        return reply.status(404).send({ error: 'Merchant not found', statusCode: 404 });
      }

      // Verify current password
      const passwordMatch = await bcrypt.compare(current_password, merchant.password_hash as string);
      if (!passwordMatch) {
        return reply.status(401).send({ error: 'Current password is incorrect', statusCode: 401 });
      }

      // Check new email is different
      if (new_email.toLowerCase() === (merchant.email as string).toLowerCase()) {
        return reply.status(400).send({ error: 'New email must be different from current email', statusCode: 400 });
      }

      // Check new email is not already used by another merchant
      const { data: existing } = await fastify.supabase
        .from('merchants')
        .select('id')
        .ilike('email', new_email)
        .neq('id', merchantId)
        .maybeSingle();

      if (existing) {
        return reply.status(409).send({ error: 'Email already registered', statusCode: 409 });
      }

      // Update email
      const { error: updateErr } = await fastify.supabase
        .from('merchants')
        .update({ email: new_email })
        .eq('id', merchantId);

      if (updateErr) {
        return reply.status(500).send({ error: 'Failed to update email', statusCode: 500 });
      }

      // Send security notifications to old AND new email
      try {
        await sendSecurityNotificationEmail(
          merchant.email as string,
          merchant.name as string,
          'email_changed',
          { newEmail: new_email },
        );
        await sendSecurityNotificationEmail(
          new_email,
          merchant.name as string,
          'email_changed',
          { newEmail: new_email },
        );
      } catch (e) {
        fastify.log.error({ err: e }, 'Failed to send email change notification');
      }

      return reply.send({ message: 'Email updated successfully', new_email });
    },
  );

  // ── POST /merchant/profile/change-password ───────────────────
  fastify.post<{ Body: ChangePasswordBody }>(
    '/merchant/profile/change-password',
    {
      schema: {
        body: {
          type: 'object',
          required: ['current_password', 'new_password'],
          properties: {
            current_password: { type: 'string', minLength: 1 },
            new_password:     { type: 'string', minLength: 8, maxLength: 128 },
          },
        },
      },
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 hour',
          keyGenerator: (req) => merchantIdFromRequest(req) ?? req.ip,
        },
      },
    },
    async (request, reply) => {
      const auth = await requireActiveMerchant(request, fastify.supabase);
      if (!auth.ok) return reply.status(auth.status).send(auth.error);

      const merchantId = auth.payload.merchant_id;
      const { current_password, new_password } = request.body;

      // Fetch merchant with password hash
      const { data: merchant, error: fetchErr } = await fastify.supabase
        .from('merchants')
        .select('id, email, password_hash, name')
        .eq('id', merchantId)
        .maybeSingle();

      if (fetchErr || !merchant) {
        return reply.status(404).send({ error: 'Merchant not found', statusCode: 404 });
      }

      // Verify current password
      const passwordMatch = await bcrypt.compare(current_password, merchant.password_hash as string);
      if (!passwordMatch) {
        return reply.status(401).send({ error: 'Current password is incorrect', statusCode: 401 });
      }

      // Hash new password (cost 12, same as register.ts)
      const newPasswordHash = await bcrypt.hash(new_password, 12);

      // Update password
      const { error: updateErr } = await fastify.supabase
        .from('merchants')
        .update({ password_hash: newPasswordHash })
        .eq('id', merchantId);

      if (updateErr) {
        return reply.status(500).send({ error: 'Failed to update password', statusCode: 500 });
      }

      // Send security notification (no plaintext password)
      try {
        await sendSecurityNotificationEmail(
          merchant.email as string,
          merchant.name as string,
          'password_changed',
        );
      } catch (e) {
        fastify.log.error({ err: e }, 'Failed to send password change notification');
      }

      return reply.send({ message: 'Password updated successfully' });
    },
  );
};

export default profileRoute;

// ── Types ──────────────────────────────────────────────────────
interface PatchProfileBody {
  name?: string;
  phone?: string;
  company_name?: string;
}

interface ChangeEmailBody {
  new_email: string;
  current_password: string;
}

interface ChangePasswordBody {
  current_password: string;
  new_password: string;
}
