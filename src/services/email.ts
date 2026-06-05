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

/* ── sendKycApprovedEmail ───────────────────────────────────── */
export async function sendKycApprovedEmail(to: string, name: string): Promise<void> {
  const api = getClient();
  if (!api) return;

  const body = `
    <h2 style="color:#1D9E75;margin:0 0 16px">Votre compte est vérifié ✅</h2>
    <p style="margin:0 0 12px">Bonjour <strong>${name}</strong>,</p>
    <p style="margin:0 0 20px">
      Votre dossier KYC a été examiné et <strong>approuvé</strong> par l'équipe UniPay Congo.
      Votre compte est maintenant pleinement actif.
    </p>
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px 20px;margin:0 0 20px">
      <p style="margin:0;font-size:14px;color:#166534;">
        ✅ Collecte Mobile Money activée<br/>
        ✅ Paiement (B2C) activé<br/>
        ✅ Accès au tableau de bord complet
      </p>
    </div>
    <a href="https://unipaycongo.com/fr/dashboard"
       style="display:inline-block;background:#1D9E75;color:#fff;text-decoration:none;
              padding:12px 28px;border-radius:8px;font-weight:600;font-size:15px;">
      Accéder au tableau de bord →
    </a>`;

  await api.transactionalEmails.sendTransacEmail({
    subject: 'Votre KYC est approuvé — UniPay Congo',
    htmlContent: layout(body),
    sender: { name: env.BREVO_SENDER_NAME, email: env.BREVO_SENDER_EMAIL },
    to: [{ email: to, name }],
  });
}

/* ── sendKycRejectedEmail ───────────────────────────────────── */
export async function sendKycRejectedEmail(to: string, name: string, reason: string): Promise<void> {
  const api = getClient();
  if (!api) return;

  const body = `
    <h2 style="color:#dc2626;margin:0 0 16px">Action requise sur votre dossier KYC</h2>
    <p style="margin:0 0 12px">Bonjour <strong>${name}</strong>,</p>
    <p style="margin:0 0 20px">
      Votre dossier KYC a été examiné. Nous ne pouvons pas le valider en l'état.
    </p>
    <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:16px 20px;margin:0 0 20px">
      <p style="margin:0 0 6px;font-size:13px;font-weight:600;color:#991b1b;">Motif de refus :</p>
      <p style="margin:0;font-size:14px;color:#7f1d1d;">${reason}</p>
    </div>
    <p style="margin:0 0 16px">
      Veuillez corriger les informations et resoumettre votre dossier.
    </p>
    <a href="https://unipaycongo.com/fr/dashboard/kyc"
       style="display:inline-block;background:#1D9E75;color:#fff;text-decoration:none;
              padding:12px 28px;border-radius:8px;font-weight:600;font-size:15px;">
      Mettre à jour mon dossier →
    </a>`;

  await api.transactionalEmails.sendTransacEmail({
    subject: 'Dossier KYC — Corrections requises — UniPay Congo',
    htmlContent: layout(body),
    sender: { name: env.BREVO_SENDER_NAME, email: env.BREVO_SENDER_EMAIL },
    to: [{ email: to, name }],
  });
}

/* ── sendAdminNewMerchantEmail ──────────────────────────────── */
export async function sendAdminNewMerchantEmail(
  merchantName: string,
  merchantEmail: string,
  company: string,
): Promise<void> {
  const api = getClient();
  if (!api) return;

  const body = `
    <h2 style="color:#1D9E75;margin:0 0 16px">Nouveau marchand enregistré 🆕</h2>
    <p style="margin:0 0 20px">Un nouveau marchand attend la validation KYC.</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <tr>
        <td style="padding:8px 12px;background:#f9fafb;border:1px solid #e5e7eb;font-weight:600;width:35%">Nom</td>
        <td style="padding:8px 12px;border:1px solid #e5e7eb">${merchantName}</td>
      </tr>
      <tr>
        <td style="padding:8px 12px;background:#f9fafb;border:1px solid #e5e7eb;font-weight:600">Email</td>
        <td style="padding:8px 12px;border:1px solid #e5e7eb">${merchantEmail}</td>
      </tr>
      <tr>
        <td style="padding:8px 12px;background:#f9fafb;border:1px solid #e5e7eb;font-weight:600">Entreprise</td>
        <td style="padding:8px 12px;border:1px solid #e5e7eb">${company || '—'}</td>
      </tr>
    </table>
    <br/>
    <a href="https://unipaycongo.com/fr/admin"
       style="display:inline-block;background:#1D9E75;color:#fff;text-decoration:none;
              padding:12px 28px;border-radius:8px;font-weight:600;font-size:15px;">
      Gérer les KYC →
    </a>`;

  await api.transactionalEmails.sendTransacEmail({
    subject: `[UniPay Admin] Nouveau marchand KYC en attente : ${merchantName}`,
    htmlContent: layout(body),
    sender: { name: env.BREVO_SENDER_NAME, email: env.BREVO_SENDER_EMAIL },
    to: [{ email: 'contact@unipaycongo.com', name: 'UniPay Admin' }],
  });
}
