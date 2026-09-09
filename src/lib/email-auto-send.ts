/**
 * Auto-send helper for admin notification emails.
 *
 * Used by admin action handlers (KYC approve, reactivate, key regen/revoke)
 * to automatically dispatch the corresponding email template.
 *
 * CRITICAL contract:
 *   - Fire-and-forget: never throws, never blocks the business action.
 *   - Logs success/failure visibly so the admin can verify after the fact.
 *   - If BREVO_API_KEY is not set or the email fails, the business action
 *     still succeeds — email is a notification, not a transactional requirement.
 */

import {
  buildEmailTemplates,
  findTemplateByLabel,
  type EmailTemplate,
  type MerchantTemplateData,
  type WalletUserTemplateData,
} from './email-templates.js';
import { sendAdminDirectEmail } from '../services/email.js';

export interface AutoSendResult {
  sent: boolean;
  templateLabel: string;
  error?: string;
}

/**
 * Build templates for the entity, find the one matching `templateLabel`,
 * and send it to `toEmail`. Returns the result but never throws.
 */
export async function sendTemplateAuto(
  entityType: 'merchant',
  data: MerchantTemplateData,
  toEmail: string,
  templateLabel: string,
  extraVars?: Record<string, string>,
): Promise<AutoSendResult>;
export async function sendTemplateAuto(
  entityType: 'wallet_user',
  data: WalletUserTemplateData,
  toEmail: string,
  templateLabel: string,
  extraVars?: Record<string, string>,
): Promise<AutoSendResult>;
export async function sendTemplateAuto(
  entityType: 'merchant' | 'wallet_user',
  data: MerchantTemplateData | WalletUserTemplateData,
  toEmail: string,
  templateLabel: string,
  extraVars: Record<string, string> = {},
): Promise<AutoSendResult> {
  try {
    const templates: EmailTemplate[] =
      entityType === 'merchant'
        ? buildEmailTemplates('merchant', data as MerchantTemplateData, extraVars)
        : buildEmailTemplates('wallet_user', data as WalletUserTemplateData, extraVars);
    const tpl = findTemplateByLabel(templates, templateLabel);
    if (!tpl) {
      return { sent: false, templateLabel, error: `Template "${templateLabel}" not found for ${entityType}` };
    }
    if (!tpl.subject || !tpl.body) {
      return { sent: false, templateLabel, error: `Template "${templateLabel}" has empty subject or body` };
    }
    await sendAdminDirectEmail(toEmail, tpl.subject, tpl.body);
    return { sent: true, templateLabel };
  } catch (err) {
    return { sent: false, templateLabel, error: (err as Error).message };
  }
}
