import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env.js';
import { sendPasswordResetEmail, sendSecurityNotificationEmail } from '../../services/email.js';

/**
 * Merchant password reset flow — "forgot password" by email.
 *
 *   POST /merchant/password-reset/request
 *     Body: { email }
 *     Always returns 200 with generic message (no account enumeration).
 *     If merchant exists: generates token, stores hash, sends email.
 *     Rate limit: 3/hour per email + 10/hour per IP.
 *
 *   POST /merchant/password-reset/confirm
 *     Body: { token, new_password }
 *     Verifies token hash, expiry (30 min), and used_at is null.
 *     On success: updates password, marks token used, invalidates all
 *     other pending tokens for this merchant, sends security notification.
 */

const GENERIC_RESPONSE = {
  message: 'Si ce compte existe, un email avec les instructions de réinitialisation a été envoyé.',
};

const passwordResetRoute: FastifyPluginAsync = async (fastify) => {

  // ── POST /merchant/password-reset/request ────────────────────
  fastify.post<{ Body: { email?: string } }>(
    '/merchant/password-reset/request',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email'],
          properties: {
            email: { type: 'string', format: 'email' },
          },
        },
      },
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 hour',
          keyGenerator: (req) => req.ip,
          // Note: per-email limit is enforced manually below (3/hour)
        },
      },
    },
    async (request, reply) => {
      const { email } = request.body;

      // Always return the same generic response — never reveal if email exists
      const genericReply = () => reply.status(200).send(GENERIC_RESPONSE);

      // Find merchant by email (case-insensitive)
      const { data: merchant, error } = await fastify.supabase
        .from('merchants')
        .select('id, email, name, status')
        .ilike('email', email!)
        .maybeSingle();

      if (error || !merchant) {
        // Merchant doesn't exist — return generic response, do nothing
        return genericReply();
      }

      // Per-email rate limit: max 3 requests per hour
      // Check how many tokens were created for this merchant in the last hour
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { count } = await fastify.supabase
        .from('merchant_password_resets')
        .select('id', { count: 'exact', head: true })
        .eq('merchant_id', merchant.id as string)
        .gte('created_at', oneHourAgo);

      if (count && count >= 3) {
        // Rate limited for this email — still return generic response
        // (don't reveal that the email exists by returning a different error)
        return genericReply();
      }

      // Generate random token (32 bytes = 64 hex chars)
      const token = crypto.randomBytes(32).toString('hex');

      // Hash the token (sha256 — fast, sufficient for short-lived tokens)
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

      // Store hash with 30-minute expiry
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

      const { error: insertError } = await fastify.supabase
        .from('merchant_password_resets')
        .insert({
          merchant_id: merchant.id,
          token_hash: tokenHash,
          expires_at: expiresAt,
        });

      if (insertError) {
        fastify.log.error({ err: insertError }, 'Failed to store password reset token');
        // Don't reveal the error — return generic response
        return genericReply();
      }

      // Build reset link
      const resetUrl = `${env.MERCHANT_PORTAL_URL}/reset-password?token=${token}`;

      // Send email with the plaintext token in the link
      try {
        await sendPasswordResetEmail(
          merchant.email as string,
          merchant.name as string,
          resetUrl,
        );
      } catch (e) {
        fastify.log.error({ err: e }, 'Failed to send password reset email');
        // Don't reveal the error — return generic response
      }

      return genericReply();
    },
  );

  // ── POST /merchant/password-reset/confirm ────────────────────
  fastify.post<{ Body: { token?: string; new_password?: string } }>(
    '/merchant/password-reset/confirm',
    {
      schema: {
        body: {
          type: 'object',
          required: ['token', 'new_password'],
          properties: {
            token:       { type: 'string', minLength: 1 },
            new_password: { type: 'string', minLength: 8, maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      const { token, new_password } = request.body;

      // Hash the provided token to compare with stored hashes
      const tokenHash = crypto.createHash('sha256').update(token!).digest('hex');

      // Find a matching, unused, non-expired token
      const { data: resetRecord, error } = await fastify.supabase
        .from('merchant_password_resets')
        .select('id, merchant_id, expires_at, used_at')
        .eq('token_hash', tokenHash)
        .is('used_at', null)
        .maybeSingle();

      if (error || !resetRecord) {
        return reply.status(400).send({
          error: 'Token invalide, expiré ou déjà utilisé. Veuillez faire une nouvelle demande.',
          statusCode: 400,
        });
      }

      // Check expiry
      if (new Date(resetRecord.expires_at as string) < new Date()) {
        return reply.status(400).send({
          error: 'Ce lien a expiré. Veuillez faire une nouvelle demande de réinitialisation.',
          statusCode: 400,
        });
      }

      const merchantId = resetRecord.merchant_id as string;

      // Fetch merchant email for notification
      const { data: merchant } = await fastify.supabase
        .from('merchants')
        .select('email, name')
        .eq('id', merchantId)
        .maybeSingle();

      // Hash new password (bcrypt cost 12, same as register.ts and profile.ts)
      const newPasswordHash = await bcrypt.hash(new_password!, 12);

      // Update merchant password
      const { error: updateErr } = await fastify.supabase
        .from('merchants')
        .update({ password_hash: newPasswordHash })
        .eq('id', merchantId);

      if (updateErr) {
        return reply.status(500).send({ error: 'Failed to update password', statusCode: 500 });
      }

      // Mark this token as used
      await fastify.supabase
        .from('merchant_password_resets')
        .update({ used_at: new Date().toISOString() })
        .eq('id', resetRecord.id as string);

      // Invalidate ALL other pending (unused, non-expired) tokens for this merchant
      await fastify.supabase
        .from('merchant_password_resets')
        .update({ used_at: new Date().toISOString() })
        .eq('merchant_id', merchantId)
        .is('used_at', null)
        .neq('id', resetRecord.id as string);

      // Send security notification email
      if (merchant) {
        try {
          await sendSecurityNotificationEmail(
            merchant.email as string,
            merchant.name as string,
            'password_changed',
          );
        } catch (e) {
          fastify.log.error({ err: e }, 'Failed to send password reset notification');
        }
      }

      return reply.send({ message: 'Mot de passe réinitialisé avec succès' });
    },
  );
};

export default passwordResetRoute;
