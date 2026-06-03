export type Channel = 'vodacash' | 'orange' | 'airtel' | 'afrimoney' | 'usdt';
export type Direction = 'deposit' | 'withdraw';
export type PaymentStatus = 'pending' | 'processing' | 'success' | 'failed';

export interface PaymentRequest {
  channel: Channel;
  direction: Direction;
  amount: number;
  currency: string;
  phone: string;
  metadata?: Record<string, unknown>;
}

export interface PaymentResponse {
  transaction_id: string;
  status: PaymentStatus;
  provider_ref: string;
  created_at: string;
}

export interface PaymentStatusResponse {
  transaction_id: string;
  status: PaymentStatus;
  channel: Channel;
  direction: Direction;
  amount_usd: number;
  amount_local: number;
  currency: string;
  phone: string;
  provider_ref: string | null;
  created_at: string;
  updated_at: string;
}

export interface CallbackPayload {
  provider_ref: string;
  status: 'success' | 'failed';
  channel?: string;
  raw_payload?: Record<string, unknown>;
}

// Provider service contract
export interface PaymentPayload {
  transaction_id: string;
  amount: number;
  currency: string;
  phone: string;
  direction: Direction;
}

export interface ProviderResponse {
  provider_ref: string;
  status: PaymentStatus;
  raw?: unknown;
}

export interface ProviderStatus {
  provider_ref: string;
  status: PaymentStatus;
  message?: string;
}
