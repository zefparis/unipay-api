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
export interface MerchantTemplateData {
    name: string;
    email: string;
    phone: string | null;
    kyc_status: string;
    mode: string;
    status: string;
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
    kyc_level: number;
    is_verified: boolean;
    is_active: boolean;
    kyc_submitted_at: string | null;
}
export declare function buildEmailTemplates(entityType: 'merchant', data: MerchantTemplateData, extraVars?: Record<string, string>): EmailTemplate[];
export declare function buildEmailTemplates(entityType: 'wallet_user', data: WalletUserTemplateData, extraVars?: Record<string, string>): EmailTemplate[];
/**
 * Find a template by label from a generated list.
 * Used by auto-send handlers to pick the right template after an action.
 */
export declare function findTemplateByLabel(templates: EmailTemplate[], label: string): EmailTemplate | undefined;
