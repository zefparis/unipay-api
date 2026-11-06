export interface InjectionDetectionResult {
    detected: boolean;
    labels: string[];
}
export declare function detectPromptInjection(message: string): InjectionDetectionResult;
export declare function wrapUserMessage(content: string): string;
export interface MerchantContext {
    name: string;
    email: string;
    kyc_status: string;
    mode: string;
    status: string;
    company_name: string | null;
    api_key_active: boolean;
    recent_transactions: Array<{
        direction: string;
        operator: string;
        amount: number | string;
        currency: string;
        status: string;
        created_at: string;
    }>;
}
export interface BotResponse {
    content: string;
    escalated: boolean;
}
export declare function generateBotReply(conversationHistory: Array<{
    role: 'merchant' | 'bot' | 'admin';
    content: string;
}>, merchantContext: MerchantContext): Promise<BotResponse>;
export interface WalletContext {
    phone: string;
    full_name: string | null;
    email: string | null;
    kyc_level: number;
    is_verified: boolean;
    is_active: boolean;
    balance_cdf: number | string;
    usd_balance: number | string;
    usdt_balance: number | string;
    cglt_balance: number | string;
    recent_transactions: Array<{
        direction: string;
        operator: string;
        amount: number | string;
        currency: string;
        status: string;
        created_at: string;
    }>;
}
export declare function generateWalletBotReply(conversationHistory: Array<{
    role: 'wallet' | 'bot' | 'admin';
    content: string;
}>, walletContext: WalletContext): Promise<BotResponse>;
