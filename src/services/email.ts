import { BrevoClient } from '@getbrevo/brevo';
import { env } from '../config/env.js';

/* ── singleton API client ───────────────────────────────────── */
function getClient(): BrevoClient | null {
  if (!env.BREVO_API_KEY) return null;
  return new BrevoClient({ apiKey: env.BREVO_API_KEY });
}

/* ── shared layout ──────────────────────────────────────────── */
function layout(body: string): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>UniPay Congo</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:32px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.07);">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#0a0f1e 0%,#0d1a2e 100%);padding:28px 40px;text-align:center;">
              <span style="font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">
                UniPay <span style="color:#1D9E75;">Congo</span>
              </span>
              <div style="width:40px;height:3px;background:#1D9E75;border-radius:2px;margin:8px auto 0;"></div>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:40px;">
              ${body}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f8fafc;padding:24px 40px;border-top:1px solid #e8ecf0;text-align:center;">
              <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.6;">
                UniPay Congo — Congo Gaming Limited S.a.r.l<br/>
                195 Av. Colonel Ebeya, Gombe, Kinshasa, République Démocratique du Congo<br/>
                <a href="https://unipaycongo.com" style="color:#1D9E75;text-decoration:none;">unipaycongo.com</a>
                &nbsp;·&nbsp;
                <a href="mailto:contact@unipaycongo.com" style="color:#1D9E75;text-decoration:none;">contact@unipaycongo.com</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/* ── sendWelcomeEmail ───────────────────────────────────────── */
export async function sendWelcomeEmail(
  to: string,
  name: string,
  apiKey: string,
): Promise<void> {
  const api = getClient();
  if (!api) {
    console.warn('[email] BREVO_API_KEY not set — welcome email skipped');
    return;
  }

  const body = `
    <h2 style="margin:0 0 8px;font-size:24px;font-weight:700;color:#0f172a;">
      Bienvenue, ${name} 👋
    </h2>
    <p style="margin:0 0 24px;font-size:15px;color:#475569;line-height:1.6;">
      Votre compte marchand <strong>UniPay Congo</strong> est activé.
      Vous pouvez commencer à accepter et envoyer des paiements Mobile Money en RDC dès maintenant.
    </p>

    <!-- API Key block -->
    <div style="background:#0d1117;border-radius:12px;padding:20px 24px;margin-bottom:24px;">
      <p style="margin:0 0 8px;font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;">
        Votre clé API
      </p>
      <code style="font-family:'Courier New',Courier,monospace;font-size:14px;color:#1D9E75;word-break:break-all;">
        ${apiKey}
      </code>
      <p style="margin:10px 0 0;font-size:11px;color:#64748b;">
        ⚠️ Conservez cette clé en lieu sûr — elle ne sera plus affichée.
      </p>
    </div>

    <!-- Info row -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
      <tr>
        <td style="padding:0 8px 0 0;width:50%;">
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;">
            <p style="margin:0 0 4px;font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#94a3b8;">Base URL</p>
            <code style="font-size:12px;color:#0f172a;">https://unipay-api.onrender.com</code>
          </div>
        </td>
        <td style="padding:0 0 0 8px;width:50%;">
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;">
            <p style="margin:0 0 4px;font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#94a3b8;">Header</p>
            <code style="font-size:12px;color:#0f172a;">X-API-Key: [votre clé]</code>
          </div>
        </td>
      </tr>
    </table>

    <!-- CTA buttons -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
      <tr>
        <td align="center" style="padding:0 6px 0 0;">
          <a href="https://unipaycongo.com/fr/api"
             style="display:inline-block;background:#1D9E75;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 24px;border-radius:10px;width:100%;box-sizing:border-box;text-align:center;">
            Documentation API
          </a>
        </td>
        <td align="center" style="padding:0 0 0 6px;">
          <a href="https://unipaycongo.com/fr/dashboard"
             style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 24px;border-radius:10px;width:100%;box-sizing:border-box;text-align:center;">
            Tableau de bord
          </a>
        </td>
      </tr>
    </table>

    <p style="margin:0;font-size:13px;color:#94a3b8;line-height:1.6;">
      Besoin d'aide ? Répondez à cet e-mail ou contactez-nous à
      <a href="mailto:contact@unipaycongo.com" style="color:#1D9E75;text-decoration:none;">contact@unipaycongo.com</a>.
    </p>
  `;

  await api.transactionalEmails.sendTransacEmail({
    subject: 'Bienvenue sur UniPay Congo — Vos identifiants API',
    htmlContent: layout(body),
    sender: { name: env.BREVO_SENDER_NAME, email: env.BREVO_SENDER_EMAIL },
    to: [{ email: to, name }],
  });
}

/* ── sendConfirmationEmail ──────────────────────────────────── */
export async function sendConfirmationEmail(
  to: string,
  name: string,
  confirmUrl: string,
): Promise<void> {
  const api = getClient();
  if (!api) {
    console.warn('[email] BREVO_API_KEY not set — confirmation email skipped');
    return;
  }

  const body = `
    <h2 style="margin:0 0 8px;font-size:24px;font-weight:700;color:#0f172a;">
      Confirmez votre adresse e-mail
    </h2>
    <p style="margin:0 0 28px;font-size:15px;color:#475569;line-height:1.6;">
      Bonjour ${name}, cliquez sur le bouton ci-dessous pour confirmer votre adresse e-mail et activer votre compte UniPay Congo.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
      <tr>
        <td align="center">
          <a href="${confirmUrl}"
             style="display:inline-block;background:#1D9E75;color:#ffffff;text-decoration:none;font-size:15px;font-weight:700;padding:14px 36px;border-radius:12px;">
            Confirmer mon adresse
          </a>
        </td>
      </tr>
    </table>
    <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.6;">
      Ce lien expire dans 24 heures. Si vous n'avez pas créé de compte, ignorez cet e-mail.
    </p>
  `;

  await api.transactionalEmails.sendTransacEmail({
    subject: 'Confirmez votre adresse — UniPay Congo',
    htmlContent: layout(body),
    sender: { name: env.BREVO_SENDER_NAME, email: env.BREVO_SENDER_EMAIL },
    to: [{ email: to, name }],
  });
}
