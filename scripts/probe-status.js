#!/usr/bin/env node
/**
 * probe-status.js — what does Unipesa /status answer for an order_id that
 * was never created? Drives the reconciliation "-1 / not found" policy.
 *
 * Usage (on the API host, after `npm run build`):
 *   node scripts/probe-status.js /etc/unipay-api.env [ORDER_ID]
 *
 * Loads the service environment file WITHOUT printing it, calls the
 * compiled getTransactionStatusWithRaw() (dist/services/avada.js — the
 * exact code the worker runs, same proxy/signature path), and prints ONLY:
 *   - HTTP status code of the /status call
 *   - type and value of the `status` field of the raw response
 *   - the top-level KEYS of the raw response (never values)
 *   - the `message` field (and result.message) if present
 * Never prints merchant_id, public_id, signature, keys, or the env file.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const envPath = process.argv[2];
const orderId = process.argv[3] || 'WW-INTROUVABLE-TEST';

if (!envPath) {
  console.error('usage: node scripts/probe-status.js <env-file> [order_id]');
  process.exit(2);
}

// ── 1. Load env file (dotenv format / systemd EnvironmentFile) silently ──
try {
  const dotenv = require('dotenv');
  const parsed = dotenv.parse(fs.readFileSync(envPath));
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  console.log(`env file loaded: ${Object.keys(parsed).length} variables (names and values not shown)`);
} catch (err) {
  console.error(`cannot read env file: ${err.code || err.message}`);
  process.exit(2);
}

// ── 2. Intercept HTTP status without touching request/response bodies ──
const undici = require('undici');
const origFetch = undici.fetch;
let httpStatus = null;
undici.fetch = async (...args) => {
  const res = await origFetch(...args);
  httpStatus = res.status;
  return res;
};

// ── 3. Call the compiled code ──
const distAvada = path.join(__dirname, '..', 'dist', 'services', 'avada.js');
if (!fs.existsSync(distAvada)) {
  console.error('dist/services/avada.js not found — run `npm run build` first');
  process.exit(2);
}
const { getTransactionStatusWithRaw } = require(distAvada);

const SENSITIVE_KEY = /merchant|signature|secret|key|token|public_id/i;

function describeStatus(v) {
  return `type=${v === null ? 'null' : typeof v} value=${typeof v === 'string' ? JSON.stringify(v) : String(v)}`;
}

(async () => {
  console.log(`order_id probed: ${orderId}`);
  try {
    const { status, raw } = await getTransactionStatusWithRaw(orderId);
    console.log(`http_status: ${httpStatus}`);
    console.log(`raw.status: ${describeStatus(raw && raw.status)}`);
    console.log(`mapped status (AvadaStatus): ${status}`);
    const keys = raw && typeof raw === 'object' ? Object.keys(raw) : [];
    console.log(`raw keys: ${keys.map((k) => (SENSITIVE_KEY.test(k) ? `${k}(redacted)` : k)).join(', ') || '(none)'}`);
    if (raw && typeof raw.message === 'string') console.log(`raw.message: ${raw.message}`);
    if (raw && raw.result && typeof raw.result === 'object') {
      const r = raw.result;
      console.log(`raw.result keys: ${Object.keys(r).join(', ')}`);
      if (r.code !== undefined) console.log(`raw.result.code: ${describeStatus(r.code)}`);
      if (typeof r.message === 'string') console.log(`raw.result.message: ${r.message}`);
    }
  } catch (err) {
    // unipesaPost throws "Unipesa HTTP <code>: <body>" on non-2xx — print
    // the code only, never the body (it may echo request fields).
    const msg = String(err && err.message);
    const m = msg.match(/^Unipesa HTTP (\d{3})/);
    console.log(`http_status: ${httpStatus ?? (m ? m[1] : 'n/a')}`);
    if (m) console.log('error: non-2xx HTTP response (body withheld)');
    else if (/^FIXIE_PROXY_REQUIRED/.test(msg)) console.log('error: FIXIE_PROXY_REQUIRED (no request sent)');
    else if (/non-JSON/.test(msg)) console.log('error: non-JSON response (body withheld)');
    else console.log(`error: ${msg.split(':')[0]}`);
    process.exitCode = 1;
  }
})();
