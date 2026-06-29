"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startBscPoller = startBscPoller;
const crypto_deposit_1 = require("../routes/wallet/crypto-deposit");
const MIN_DEPOSIT_USD = 1; // ignore dust < $1
const POLL_INTERVAL_MS = 15_000; // 15 seconds
const WCGLT_PER_USDT = 500; // 1 wCGLT = 1/500 USD
/* ── wCGLT → USD conversion ─────────────────────────────────────────────── */
function wcgltToUsd(amount) {
    return amount / WCGLT_PER_USDT;
}
/* ── BSCScan tokentx query for a single address ─────────────────────────── */
async function fetchTxsForAddress(contractAddress, depositAddress, fromBlock, apiKey) {
    const url = `https://api.bscscan.com/api?module=account&action=tokentx` +
        `&contractaddress=${contractAddress}` +
        `&address=${depositAddress}` +
        `&startblock=${fromBlock + 1}` +
        `&endblock=latest` +
        `&sort=asc` +
        `&apikey=${apiKey}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.status !== '1' || !Array.isArray(data.result))
        return [];
    return data.result;
}
/* ── Process one token across all user addresses ────────────────────────── */
async function checkDepositsForToken(supabase, symbol, contractAddress, decimals, apiKey, log) {
    const configKey = `last_bsc_block_${symbol.toLowerCase()}`;
    // 1. Load all active deposit addresses
    const { data: addresses } = await supabase
        .from('user_deposit_addresses')
        .select('user_id, bsc_address');
    if (!addresses?.length)
        return;
    // 2. Fetch last processed block
    const { data: cfg } = await supabase
        .from('system_config')
        .select('value')
        .eq('key', configKey)
        .single();
    const lastBlock = parseInt(cfg?.value ?? '0', 10);
    let maxBlock = lastBlock;
    // 3. Query BSCScan for each address (rate: max 5 req/s on free tier)
    for (const { user_id, bsc_address } of addresses) {
        let txs;
        try {
            txs = await fetchTxsForAddress(contractAddress, bsc_address, lastBlock, apiKey);
        }
        catch (err) {
            log(`[bscscan] fetch error for ${bsc_address}`, err);
            continue;
        }
        for (const tx of txs) {
            // Only inbound transfers to this address
            if (tx.to.toLowerCase() !== bsc_address.toLowerCase())
                continue;
            const blockNum = parseInt(tx.blockNumber, 10);
            if (blockNum > maxBlock)
                maxBlock = blockNum;
            // Idempotence: skip if already recorded
            const { data: exists } = await supabase
                .from('crypto_deposits')
                .select('id')
                .eq('tx_hash', tx.hash)
                .maybeSingle();
            if (exists)
                continue;
            // Calculate USD amount
            const rawAmt = BigInt(tx.value);
            const amount = Number(rawAmt) / Math.pow(10, decimals);
            const amountUsd = symbol === 'USDT' ? amount : wcgltToUsd(amount);
            // Minimum deposit guard
            if (amountUsd < MIN_DEPOSIT_USD) {
                log(`[bscscan] dust ignored: ${amount} ${symbol} from ${tx.from}`);
                continue;
            }
            // 4. Record the deposit
            const { error: insertErr } = await supabase
                .from('crypto_deposits')
                .insert({
                user_id,
                tx_hash: tx.hash,
                token_symbol: symbol,
                token_contract: contractAddress,
                amount_raw: tx.value,
                amount_usd: amountUsd,
                from_address: tx.from,
                to_address: tx.to,
                block_number: blockNum,
                status: 'CONFIRMED',
            });
            if (insertErr) {
                // Unique violation = race condition duplicate — safe to skip
                if (insertErr.code === '23505')
                    continue;
                log(`[bscscan] insert error for ${tx.hash}`, insertErr);
                continue;
            }
            // 5. Credit usd_balance
            const { error: creditErr } = await supabase
                .rpc('wallet_credit_usd', { p_user_id: user_id, p_amount: amountUsd });
            if (creditErr) {
                log(`[bscscan] credit failed for ${user_id}: ${amountUsd} USD`, creditErr);
            }
            else {
                log(`[bscscan] credited ${amountUsd.toFixed(6)} USD (${amount} ${symbol}) to user ${user_id} — tx ${tx.hash}`);
            }
        }
    }
    // 6. Persist max block seen
    if (maxBlock > lastBlock) {
        await supabase
            .from('system_config')
            .update({ value: String(maxBlock), updated_at: new Date().toISOString() })
            .eq('key', configKey);
    }
}
/* ── Start polling loop ─────────────────────────────────────────────────── */
function startBscPoller(supabase, logger) {
    const apiKey = process.env.BSCSCAN_API_KEY;
    if (!apiKey) {
        logger.info('[bscscan] BSCSCAN_API_KEY not set — BSC deposit polling disabled');
        return;
    }
    if (!process.env.UNIPAY_HD_WALLET_MNEMONIC) {
        logger.info('[bscscan] UNIPAY_HD_WALLET_MNEMONIC not set — BSC deposit polling disabled');
        return;
    }
    logger.info('[bscscan] BSC deposit poller started (15 s interval)');
    const tick = async () => {
        for (const token of crypto_deposit_1.SUPPORTED_TOKENS) {
            try {
                await checkDepositsForToken(supabase, token.symbol, token.contract, token.decimals, apiKey, (msg, data) => data ? logger.info(msg, data) : logger.info(msg));
            }
            catch (err) {
                logger.error(`[bscscan] unhandled error for ${token.symbol}`, err);
            }
        }
    };
    // Run immediately on startup, then every 15 s
    tick().catch((err) => logger.error('[bscscan] first tick failed', err));
    setInterval(() => {
        tick().catch((err) => logger.error('[bscscan] tick failed', err));
    }, POLL_INTERVAL_MS);
}
//# sourceMappingURL=bscscan.js.map