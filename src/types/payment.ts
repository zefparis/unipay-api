export type Channel = 'vodacash' | 'orange' | 'airtel' | 'afrimoney' | 'usdt';
export type Direction = 'collect' | 'payout';
export type PaymentStatus = 'pending' | 'processing' | 'success' | 'failed' | 'cancelled';

export interface PaymentRequest {
  operator: Channel;
  direction: Direction;
  amount: number;
  currency: string;
  phone: string;
  reference?: string;
  metadata?: Record<string, unknown>;
}

export interface PaymentResponse {
  transaction_id: string;
  status: PaymentStatus;
  amount: number;
  fee: number;
  net_amount: number;
  currency: string;
}

export interface PaymentStatusResponse {
  transaction_id: string;
  status: PaymentStatus;
  operator: Channel;
  direction: Direction;
  amount: number;
  fee: number;
  net_amount: number;
  currency: string;
  phone: string;
  reference: string | null;
  avada_transaction_id: string | null;
  created_at: string;
  updated_at: string;
}

// Provider service contract (internal)
export interface PaymentPayload {
  transaction_id: string;
  amount: number;
  currency: string;
  phone: string;
  direction: Direction;
  reference: string;
}

export interface ProviderResponse {
  provider_ref: string;      // = avada_transaction_id for Avada channels
  status: PaymentStatus;
  raw?: unknown;
}

export interface ProviderStatus {
  provider_ref: string;
  status: PaymentStatus;
  message?: string;
}
