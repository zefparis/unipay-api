import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decideFromStatus, recheckProviderStatus, RECHECK_TIMEOUT_MS } from '../provider-recheck';

const CALLBACK = readFileSync('src/routes/payment/callback.ts', 'utf8');

/* ─────────────────────────────────────────────────────────────────
   Décision pure — 3 cas exactement
   ───────────────────────────────────────────────────────────────── */
describe('decideFromStatus — 3 cas', () => {
  it('success → credit', () => {
    assert.deepEqual(decideFromStatus('success'), { action: 'credit' });
  });
  it('failed / cancelled / rejected → reject', () => {
    for (const s of ['failed', 'cancelled', 'rejected']) {
      assert.deepEqual(decideFromStatus(s), { action: 'reject', providerStatus: s });
    }
  });
  it('pending → defer (PAS reject — bug corrigé)', () => {
    assert.equal(decideFromStatus('pending').action, 'defer');
  });
  it('processing → defer', () => {
    assert.equal(decideFromStatus('processing').action, 'defer');
  });
  it('statut inconnu → defer', () => {
    assert.equal(decideFromStatus('weird_status').action, 'defer');
    assert.equal(decideFromStatus(undefined).action, 'defer');
    assert.equal(decideFromStatus(null).action, 'defer');
  });
});

/* ─────────────────────────────────────────────────────────────────
   Appel avec timeout
   ───────────────────────────────────────────────────────────────── */
describe('recheckProviderStatus — appel + timeout', () => {
  it('success confirmé → credit', async () => {
    const d = await recheckProviderStatus(async () => ({ status: 'success' }));
    assert.equal(d.action, 'credit');
  });
  it('provider failed → reject', async () => {
    const d = await recheckProviderStatus(async () => ({ status: 'failed' }));
    assert.equal(d.action, 'reject');
  });
  it('provider pending → defer', async () => {
    const d = await recheckProviderStatus(async () => ({ status: 'pending' }));
    assert.equal(d.action, 'defer');
  });
  it('erreur réseau → defer avec la raison', async () => {
    const d = await recheckProviderStatus(async () => { throw new Error('ECONNRESET'); });
    assert.equal(d.action, 'defer');
    assert.match((d as { reason: string }).reason, /ECONNRESET/);
  });
  it('timeout → defer en ≤ timeout (pas 5 s réels : timeout injecté 50 ms)', async () => {
    const t0 = Date.now();
    const d = await recheckProviderStatus(
      () => new Promise(() => { /* ne répond jamais */ }),
      50,
    );
    assert.equal(d.action, 'defer');
    assert.match((d as { reason: string }).reason, /timeout/);
    assert.ok(Date.now() - t0 < 1000);
  });
  it('clearTimeout quand la réponse arrive avant : le process ne reste pas bloqué par un timer', async () => {
    // Si le timer n'était pas nettoyé, un setTimeout de 5 s resterait actif.
    // On vérifie qu'avec un timeout long, la promesse résout immédiatement
    // et que le test rend la main sans attendre.
    const t0 = Date.now();
    await recheckProviderStatus(async () => ({ status: 'success' }), 60_000);
    assert.ok(Date.now() - t0 < 500);
  });
  it('timeout par défaut = 5 s', () => {
    assert.equal(RECHECK_TIMEOUT_MS, 5000);
  });
});

/* ─────────────────────────────────────────────────────────────────
   Câblage dans callback.ts
   ───────────────────────────────────────────────────────────────── */
describe('callback.ts — câblage de la revérification', () => {
  it('ne revérifie que sur dbStatus === success', () => {
    assert.match(CALLBACK, /if \(dbStatus === 'success'\) \{\s*\n\s*const decision = await recheckProviderStatus/);
  });
  it('reject → 400, defer → 503, avant la RPC de crédit', () => {
    const recheckIdx = CALLBACK.indexOf('recheckProviderStatus(');
    const rpcIdx = CALLBACK.indexOf("'process_wallet_provider_callback'");
    assert.ok(recheckIdx > 0 && recheckIdx < rpcIdx, 'recheck doit précéder la RPC');
    assert.match(CALLBACK, /decision\.action === 'reject'[\s\S]{0,300}status\(400\)/);
    assert.match(CALLBACK, /decision\.action === 'defer'[\s\S]{0,300}status\(503\)/);
  });
  it('utilise tx.reference comme clé /status (comme la réconciliation)', () => {
    assert.match(CALLBACK, /getTransactionStatusWithRaw\(tx!\.reference \?\? avada_transaction_id\)/);
  });
  it('callback failed : pas de revérification (chemin inchangé)', () => {
    // le bloc est gardé par dbStatus === 'success' ; un callback failed saute au RPC
    assert.doesNotMatch(CALLBACK, /dbStatus === 'failed'[\s\S]{0,200}recheckProviderStatus/);
  });
});
