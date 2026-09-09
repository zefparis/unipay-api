/**
 * Unified email template builder for admin→entity (merchant or wallet user) emails.
 *
 * Replaces the two parallel inline implementations that lived in
 * `routes/admin/merchants.ts` and `routes/admin/wallet.ts`.
 *
 * Templates use `{placeholder}` syntax, substituted at generation time so the
 * admin sees the final text pre-filled in the modal. For automatic sends
 * (KYC approve, reactivate, key regen/revoke), the same helper is called with
 * the current entity data and the relevant template is dispatched.
 */

export type EntityType = 'merchant' | 'wallet_user';

export interface EmailTemplate {
  label: string;
  subject: string;
  body: string;
}

/* ── Entity data shapes ─────────────────────────────────────── */

export interface MerchantTemplateData {
  name: string;
  email: string;
  kyc_status: string;          // 'pending' | 'submitted' | 'approved' | 'rejected'
  mode: string;                // 'sandbox' | 'live'
  status: string;              // 'active' | 'suspended'
  company_name: string | null;
  company_rccm: string | null;
  company_idnat: string | null;
  kyc_notes: string | null;
  kyc_submitted_at: string | null;
  kyc_reviewed_at: string | null;
}

export interface WalletUserTemplateData {
  phone: string;
  full_name: string | null;
  email: string | null;
  kyc_level: number;           // 0 | 1 | 2
  is_verified: boolean;
  is_active: boolean;
  kyc_submitted_at: string | null;
}

/* ── Placeholder substitution ──────────────────────────────── */

function replacePlaceholders(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? '');
}

/* ── Merchant templates ────────────────────────────────────── */

function buildMerchantTemplates(
  m: MerchantTemplateData,
  extraVars: Record<string, string> = {},
): EmailTemplate[] {
  const name = m.name ?? m.email;
  const vars: Record<string, string> = {
    merchant_name: name,
    kyc_status: m.kyc_status,
    mode: m.mode,
    company_name: m.company_name ?? '—',
    company_rccm: m.company_rccm ?? '—',
    company_idnat: m.company_idnat ?? '—',
    kyc_notes: m.kyc_notes ?? '',
    api_key_label: extraVars.api_key_label ?? 'votre clé API',
    ...extraVars,
  };

  const templates: EmailTemplate[] = [];

  // A — Complément KYC ciblé (pending + identifiable missing fields)
  if (m.kyc_status === 'pending') {
    const missing: string[] = [];
    if (!m.company_rccm) missing.push('RCCM (Registre de Commerce)');
    if (!m.company_idnat) missing.push('ID National');

    if (missing.length > 0) {
      const missingFields = missing.join(' et ');
      templates.push({
        label: 'Complément KYC ciblé',
        subject: 'Action requise : documents manquants pour votre KYC UniPay Congo',
        body: replacePlaceholders(
          `Bonjour {merchant_name},\n\n` +
          `Votre dossier KYC est en attente mais incomplet. Pour finaliser votre vérification, ` +
          `il nous manque le(s) document(s) suivant(s) :\n\n  - {missing_fields}\n\n` +
          `Pour soumettre ces documents :\n  1. Connectez-vous à votre tableau de bord marchand\n  2. Section KYC → Compléter mon dossier\n  3. Téléversez le(s) document(s) manquant(s)\n\n` +
          `Sans ces documents, votre compte reste en mode sandbox et ne peut pas traiter de paiements réels.\n\n` +
          `Cordialement,\nL'équipe UniPay Congo`,
          { ...vars, missing_fields: missingFields },
        ),
      });
    } else {
      // Fallback: pending but no identifiable missing fields → generic relance
      templates.push({
        label: 'Relance KYC',
        subject: 'Action requise : finalisation de votre KYC UniPay Congo',
        body: replacePlaceholders(
          `Bonjour {merchant_name},\n\n` +
          `Nous avons constaté que votre dossier KYC n'a pas encore été soumis. Sans KYC validé, ` +
          `votre compte reste en mode sandbox et vous ne pouvez pas traiter de paiements réels.\n\n` +
          `Pour soumettre votre dossier, rendez-vous dans votre tableau de bord → section KYC. ` +
          `Vous aurez besoin de :\n  - Votre pièce d'identité (IDNat ou passeport)\n  - Votre registre de commerce (RCCM)\n  - La raison sociale de votre entreprise\n\n` +
          `Une fois le KYC approuvé, votre compte passera automatiquement en mode live.\n\n` +
          `Cordialement,\nL'équipe UniPay Congo`,
          vars,
        ),
      });
    }
  }

  // Existing — KYC submitted (in review)
  if (m.kyc_status === 'submitted') {
    templates.push({
      label: 'KYC en cours de revue',
      subject: 'Votre dossier KYC est en cours de revue',
      body: replacePlaceholders(
        `Bonjour {merchant_name},\n\n` +
        `Nous accusons réception de votre dossier KYC. Notre équipe est actuellement en train de l'examiner. ` +
        `Vous recevrez une notification dès que la revue sera terminée.\n\n` +
        `Ce processus prend généralement 24 à 48 heures ouvrées.\n\n` +
        `Cordialement,\nL'équipe UniPay Congo`,
        vars,
      ),
    });
  }

  // B — KYC rejeté
  if (m.kyc_status === 'rejected') {
    const notesSection = m.kyc_notes
      ? replacePlaceholders(`Motif : {kyc_notes}\n\n`, vars)
      : '';
    templates.push({
      label: 'KYC rejeté',
      subject: 'Votre dossier KYC nécessite des corrections — UniPay Congo',
      body: replacePlaceholders(
        `Bonjour {merchant_name},\n\n` +
        `Votre dossier KYC a été examiné. Nous ne pouvons pas le valider en l'état.\n\n` +
        notesSection +
        `Veuillez corriger les informations et resoumettre votre dossier via votre tableau de bord → section KYC.\n\n` +
        `Cordialement,\nL'équipe UniPay Congo`,
        vars,
      ),
    });
  }

  // C — KYC approuvé
  if (m.kyc_status === 'approved') {
    templates.push({
      label: 'KYC approuvé',
      subject: 'Votre KYC est approuvé — UniPay Congo',
      body: replacePlaceholders(
        `Bonjour {merchant_name},\n\n` +
        `Bonne nouvelle : votre dossier KYC a été approuvé. Votre compte est désormais vérifié ` +
        `et vous pouvez traiter des paiements réels.\n\n` +
        `Cordialement,\nL'équipe UniPay Congo`,
        vars,
      ),
    });
  }

  // Existing — Passage en mode live (approved + still sandbox)
  if (m.kyc_status === 'approved' && m.mode === 'sandbox') {
    templates.push({
      label: 'Passage en mode live',
      subject: 'Votre KYC est approuvé — passez en mode live',
      body: replacePlaceholders(
        `Bonjour {merchant_name},\n\n` +
        `Bonne nouvelle : votre dossier KYC a été approuvé. Votre compte est actuellement en mode sandbox. ` +
        `Vous pouvez désormais passer en mode live pour traiter des paiements réels.\n\n` +
        `Pour activer le mode live, rendez-vous dans votre tableau de bord → Paramètres, ` +
        `ou contactez-nous si vous avez besoin d'assistance.\n\n` +
        `Cordialement,\nL'équipe UniPay Congo`,
        vars,
      ),
    });
  }

  // D — Compte suspendu
  if (m.status === 'suspended') {
    templates.push({
      label: 'Compte suspendu',
      subject: 'Votre compte marchand UniPay Congo est suspendu',
      body: replacePlaceholders(
        `Bonjour {merchant_name},\n\n` +
        `Votre compte marchand UniPay Congo a été suspendu. Pour lever la suspension, ` +
        `veuillez contacter notre équipe de support en répondant à cet email ou via votre tableau de bord.\n\n` +
        `Cordialement,\nL'équipe UniPay Congo`,
        vars,
      ),
    });
  }

  // E — Compte réactivé (shown when active, after a suspension)
  if (m.status === 'active') {
    templates.push({
      label: 'Compte réactivé',
      subject: 'Votre compte marchand UniPay Congo est réactivé',
      body: replacePlaceholders(
        `Bonjour {merchant_name},\n\n` +
        `Votre compte marchand UniPay Congo a été réactivé. Vous pouvez de nouveau accéder ` +
        `à votre tableau de bord et traiter des paiements.\n\n` +
        `Cordialement,\nL'équipe UniPay Congo`,
        vars,
      ),
    });
  }

  // F — Régénération de clé API
  templates.push({
    label: 'Régénération de clé API',
    subject: 'UniPay Congo — Votre clé API a été régénérée',
    body: replacePlaceholders(
      `Bonjour {merchant_name},\n\n` +
      `Suite à une régénération de sécurité, votre clé API ({api_key_label}) a été renouvelée. ` +
      `Votre ancienne clé est désactivée et ne permet plus d'accéder à l'API UniPay Congo.\n\n` +
      `La nouvelle clé vous a été communiquée séparément. Conservez-la en lieu sûr — elle ne sera plus affichée.\n\n` +
      `Cordialement,\nL'équipe UniPay Congo`,
      vars,
    ),
  });

  // G — Révocation de clé API
  templates.push({
    label: 'Révocation de clé API',
    subject: 'UniPay Congo — Votre clé API a été révoquée',
    body: replacePlaceholders(
      `Bonjour {merchant_name},\n\n` +
      `Votre clé API ({api_key_label}) a été révoquée. Elle ne permet plus d'accéder à l'API UniPay Congo.\n\n` +
      `Si vous avez besoin d'une nouvelle clé, contactez notre équipe ou générez-en une depuis votre tableau de bord.\n\n` +
      `Cordialement,\nL'équipe UniPay Congo`,
      vars,
    ),
  });

  // Generic — always available
  templates.push({
    label: 'Réponse à votre demande',
    subject: '',
    body: replacePlaceholders(`Bonjour {merchant_name},\n\n`, vars),
  });

  return templates;
}

/* ── Wallet user templates ─────────────────────────────────── */

function buildWalletUserTemplates(
  u: WalletUserTemplateData,
  _extraVars: Record<string, string> = {},
): EmailTemplate[] {
  const name = u.full_name ?? u.phone;
  const vars: Record<string, string> = {
    wallet_user_name: name,
    kyc_level: String(u.kyc_level),
  };

  const templates: EmailTemplate[] = [];

  // Existing — KYC level 0 → encourage upgrade to level 1
  if (u.kyc_level === 0) {
    templates.push({
      label: 'Relance KYC niveau 1',
      subject: 'Vérifiez votre compte UniPay pour augmenter vos limites',
      body: replacePlaceholders(
        `Bonjour {wallet_user_name},\n\n` +
        `Votre compte UniPay est actuellement au niveau KYC 0, ce qui limite vos transactions à 5 000 CDF par jour.\n\n` +
        `Pour augmenter vos limites (jusqu'à 500 000 CDF/jour en dépôt et 200 000 CDF/jour en retrait), ` +
        `soumettez votre pièce d'identité dans l'application :\n` +
        `  1. Onglet Profil → Vérification KYC\n  2. Photo de votre pièce d'identité (recto/verso)\n  3. Selfie de vérification\n\n` +
        `La validation prend généralement 24 à 48 heures.\n\n` +
        `Cordialement,\nL'équipe UniPay Congo`,
        vars,
      ),
    });
  }

  // Existing — KYC level 1 → encourage cognitive upgrade to level 2
  if (u.kyc_level === 1) {
    templates.push({
      label: 'Upgrade KYC niveau 2',
      subject: 'Débloquez toutes les fonctionnalités avec le KYC niveau 2',
      body: replacePlaceholders(
        `Bonjour {wallet_user_name},\n\n` +
        `Votre compte est au niveau KYC 1. Pour accéder aux limites maximales (transactions illimitées) ` +
        `et à toutes les fonctionnalités UniPay, vous pouvez passer au niveau 2 en complétant le test cognitif ` +
        `dans l'application :\n  1. Onglet Profil → Vérification KYC → Upgrade\n  2. Complétez le test cognitif (Stroop, mémoire, etc.)\n\n` +
        `Cordialement,\nL'équipe UniPay Congo`,
        vars,
      ),
    });
  }

  // New — KYC niveau 1 validé (shown when kyc_level >= 1 and is_verified)
  if (u.kyc_level >= 1 && u.is_verified) {
    templates.push({
      label: 'KYC niveau 1 validé',
      subject: 'Votre vérification KYC est approuvée — UniPay Congo',
      body: replacePlaceholders(
        `Bonjour {wallet_user_name},\n\n` +
        `Bonne nouvelle : votre vérification KYC a été approuvée. Votre compte est désormais vérifié ` +
        `et vos limites de transaction ont été augmentées.\n\n` +
        `Cordialement,\nL'équipe UniPay Congo`,
        vars,
      ),
    });
  }

  // New — KYC rejeté (wallet user equivalent of merchant template B)
  if (u.kyc_submitted_at && u.kyc_level === 0) {
    templates.push({
      label: 'KYC rejeté',
      subject: 'Votre vérification KYC nécessite des corrections — UniPay Congo',
      body: replacePlaceholders(
        `Bonjour {wallet_user_name},\n\n` +
        `Votre dossier de vérification KYC a été examiné. Nous ne pouvons pas le valider en l'état.\n\n` +
        `Veuillez corriger les informations et resoumettre votre dossier dans l'application :\n` +
        `  Onglet Profil → Vérification KYC\n\n` +
        `Cordialement,\nL'équipe UniPay Congo`,
        vars,
      ),
    });
  }

  // Existing — Compte suspendu (blocked)
  if (!u.is_active) {
    templates.push({
      label: 'Compte suspendu',
      subject: 'Votre compte UniPay est suspendu',
      body: replacePlaceholders(
        `Bonjour {wallet_user_name},\n\n` +
        `Votre compte UniPay a été suspendu pour des raisons de sécurité. Pour lever la suspension, ` +
        `veuillez contacter notre équipe de support en répondant à cet email ou via l'application.\n\n` +
        `Cordialement,\nL'équipe UniPay Congo`,
        vars,
      ),
    });
  }

  // New — Compte réactivé (unblocked)
  if (u.is_active) {
    templates.push({
      label: 'Compte réactivé',
      subject: 'Votre compte UniPay est réactivé',
      body: replacePlaceholders(
        `Bonjour {wallet_user_name},\n\n` +
        `Votre compte UniPay a été réactivé. Vous pouvez de nouveau accéder à votre wallet ` +
        `et effectuer des transactions.\n\n` +
        `Cordialement,\nL'équipe UniPay Congo`,
        vars,
      ),
    });
  }

  // Generic — always available
  templates.push({
    label: 'Réponse à votre demande',
    subject: '',
    body: replacePlaceholders(`Bonjour {wallet_user_name},\n\n`, vars),
  });

  return templates;
}

/* ── Public API ────────────────────────────────────────────── */

export function buildEmailTemplates(
  entityType: 'merchant',
  data: MerchantTemplateData,
  extraVars?: Record<string, string>,
): EmailTemplate[];
export function buildEmailTemplates(
  entityType: 'wallet_user',
  data: WalletUserTemplateData,
  extraVars?: Record<string, string>,
): EmailTemplate[];
export function buildEmailTemplates(
  entityType: EntityType,
  data: MerchantTemplateData | WalletUserTemplateData,
  extraVars: Record<string, string> = {},
): EmailTemplate[] {
  if (entityType === 'merchant') {
    return buildMerchantTemplates(data as MerchantTemplateData, extraVars);
  }
  return buildWalletUserTemplates(data as WalletUserTemplateData, extraVars);
}

/**
 * Find a template by label from a generated list.
 * Used by auto-send handlers to pick the right template after an action.
 */
export function findTemplateByLabel(
  templates: EmailTemplate[],
  label: string,
): EmailTemplate | undefined {
  return templates.find((t) => t.label === label);
}
