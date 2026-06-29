/**
 * Admin — Treasury Crypto Assets
 *
 * Endpoints:
 *   GET  /admin/treasury/crypto-assets          On-chain balances + accounting totals
 *   GET  /admin/treasury/crypto-wallets         List registered treasury wallets
 *   POST /admin/treasury/crypto-wallets         Register a new treasury wallet
 *   PATCH /admin/treasury/crypto-wallets/:id    Update / deactivate a wallet
 *
 * READ-ONLY blockchain access.  No private keys.  No signing.  No withdrawals.
 * No user wallet credits.
 */
import type { FastifyPluginAsync } from 'fastify';
declare const adminTreasuryCryptoAssetsRoute: FastifyPluginAsync;
export default adminTreasuryCryptoAssetsRoute;
