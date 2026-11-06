"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendTemplateAuto = sendTemplateAuto;
const email_templates_js_1 = require("./email-templates.js");
const email_js_1 = require("../services/email.js");
async function sendTemplateAuto(entityType, data, toEmail, templateLabel, extraVars = {}) {
    try {
        const templates = entityType === 'merchant'
            ? (0, email_templates_js_1.buildEmailTemplates)('merchant', data, extraVars)
            : (0, email_templates_js_1.buildEmailTemplates)('wallet_user', data, extraVars);
        const tpl = (0, email_templates_js_1.findTemplateByLabel)(templates, templateLabel);
        if (!tpl) {
            return { sent: false, templateLabel, error: `Template "${templateLabel}" not found for ${entityType}` };
        }
        if (!tpl.subject || !tpl.body) {
            return { sent: false, templateLabel, error: `Template "${templateLabel}" has empty subject or body` };
        }
        await (0, email_js_1.sendAdminDirectEmail)(toEmail, tpl.subject, tpl.body);
        return { sent: true, templateLabel };
    }
    catch (err) {
        return { sent: false, templateLabel, error: err.message };
    }
}
//# sourceMappingURL=email-auto-send.js.map