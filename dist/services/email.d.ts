export declare function sendWelcomeEmail(to: string, name: string, apiKey: string): Promise<void>;
export declare function sendConfirmationEmail(to: string, name: string, confirmUrl: string): Promise<void>;
export declare function sendKycApprovedEmail(to: string, name: string): Promise<void>;
export declare function sendKycRejectedEmail(to: string, name: string, reason: string): Promise<void>;
export declare function sendWalletWelcomeEmail(to: string, name: string, phone: string, lang?: string): Promise<void>;
export declare function sendWalletDepositEmail(params: {
    to: string;
    name: string;
    amount: string;
    currency: string;
    method: string;
    txRef: string;
    lang?: string;
}): Promise<void>;
export declare function sendWalletTransferEmail(params: {
    to: string;
    name: string;
    amount: string;
    currency: string;
    recipient: string;
    txRef: string;
    lang?: string;
}): Promise<void>;
export declare function sendWalletWithdrawalEmail(params: {
    to: string;
    name: string;
    amount: string;
    currency: string;
    phone: string;
    operator: string;
    txRef: string;
    lang?: string;
}): Promise<void>;
export declare function sendWalletPinChangedEmail(params: {
    to: string;
    name: string;
    phone: string;
    lang?: string;
}): Promise<void>;
export declare function sendAdminNewMerchantEmail(merchantName: string, merchantEmail: string, company: string): Promise<void>;
export declare function sendGasAlertEmail(walletAddress: string, currentBnb: number, threshold: number, adminEmails: string[]): Promise<void>;
