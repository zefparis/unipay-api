import { CdpClient } from '@coinbase/cdp-sdk';

let _client: CdpClient | null = null;

function getClient(): CdpClient {
  if (!_client) {
    if (!process.env.CDP_API_KEY_ID || !process.env.CDP_API_KEY_SECRET || !process.env.CDP_WALLET_SECRET) {
      throw new Error('CDP_API_KEY_ID, CDP_API_KEY_SECRET and CDP_WALLET_SECRET must be set');
    }
    _client = new CdpClient({
      apiKeyId:     process.env.CDP_API_KEY_ID,
      apiKeySecret: process.env.CDP_API_KEY_SECRET,
      walletSecret: process.env.CDP_WALLET_SECRET,
    });
  }
  return _client;
}

function accountName(userId: string): string {
  return `user-${userId}`;
}

export async function createUserWallet(userId: string): Promise<string> {
  const cdp = getClient();
  const account = await cdp.evm.getOrCreateAccount({ name: accountName(userId) });
  return account.address;
}

export async function getUserWalletAddress(userId: string): Promise<string | null> {
  try {
    const cdp = getClient();
    const account = await cdp.evm.getAccount({ name: accountName(userId) });
    return account.address;
  } catch {
    return null;
  }
}
