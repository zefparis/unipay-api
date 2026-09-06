/**
 * One-off script: redistribute regenerated API keys to merchants via email.
 *
 * Reads a JSON file (array of { merchant_id, name, email, new_api_key }),
 * excludes internal test accounts, and sends a "key rotation" email to each
 * remaining merchant.
 *
 * Usage:
 *   npx tsx scripts/redistribute-api-keys.ts --file /tmp/new-keys.json --dry-run
 *   npx tsx scripts/redistribute-api-keys.ts --file /tmp/new-keys.json --send
 *
 * --dry-run is the DEFAULT. Emails are only sent with the explicit --send flag.
 *
 * JSON format expected (a JSON array):
 *   [
 *     { "merchant_id": "uuid", "name": "...", "email": "...", "new_api_key": "up_..." },
 *     ...
 *   ]
 *
 * Output:
 *   - dry-run: prints the list of emails that WOULD be sent to stdout
 *   - send: logs each send result to stderr, prints a summary at the end
 */

import fs from 'node:fs';
import path from 'node:path';

/* ── Internal test accounts excluded from mass sending ──────── */
const EXCLUDED_EMAILS = new Set([
  'test@unipaycongo.com',
  'lecoinrdc@gmail.com',
  'ben.barere@gmail.com',
  'contact@ia-solution.fr',
  'b.barrere@congogaming.com',
]);

interface KeyEntry {
  merchant_id: string;
  name: string;
  email: string;
  new_api_key: string;
}

function parseArgs(argv: string[]): { file: string; send: boolean } {
  let file = '';
  let send = false;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--file') {
      file = argv[++i] ?? '';
    } else if (arg === '--send') {
      send = true;
    } else if (arg === '--dry-run') {
      send = false;
    } else if (arg.startsWith('--file=')) {
      file = arg.slice('--file='.length);
    } else {
      console.error(`Unknown argument: ${arg}`);
      printUsage();
      process.exit(1);
    }
  }
  if (!file) {
    console.error('Missing --file argument');
    printUsage();
    process.exit(1);
  }
  return { file, send };
}

function printUsage(): void {
  console.error(
    'Usage: npx tsx scripts/redistribute-api-keys.ts --file <path-to-json> [--dry-run|--send]',
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const { file, send } = parseArgs(process.argv);

  const filePath = path.resolve(process.cwd(), file);
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  let entries: KeyEntry[];
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.error('JSON file must contain an array at the top level');
      process.exit(1);
    }
    entries = parsed as KeyEntry[];
  } catch (err) {
    console.error('Failed to parse JSON:', err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // Validate entries
  for (const e of entries) {
    if (!e.merchant_id || !e.name || !e.email || !e.new_api_key) {
      console.error(
        `Invalid entry (missing field): ${JSON.stringify(e)}`,
      );
      process.exit(1);
    }
  }

  // Split into excluded and to-send
  const excluded: KeyEntry[] = [];
  const toSend: KeyEntry[] = [];
  for (const e of entries) {
    if (EXCLUDED_EMAILS.has(e.email.toLowerCase())) {
      excluded.push(e);
    } else {
      toSend.push(e);
    }
  }

  console.error(`\n=== Redistribution des clés API ===`);
  console.error(`Total entries:    ${entries.length}`);
  console.error(`Excluded (test):  ${excluded.length}`);
  console.error(`To send:          ${toSend.length}`);
  console.error(`Mode:             ${send ? 'SEND (real emails)' : 'DRY-RUN (no emails sent)'}\n`);

  if (excluded.length > 0) {
    console.error('Excluded test accounts:');
    for (const e of excluded) {
      console.error(`  - ${e.email} (${e.name})`);
    }
    console.error('');
  }

  if (!send) {
    // Dry-run: print what WOULD be sent to stdout
    for (const e of toSend) {
      console.log(
        JSON.stringify({
          merchant_id: e.merchant_id,
          name: e.name,
          email: e.email,
          new_api_key: e.new_api_key,
        }),
      );
    }
    console.error(`\nDry-run complete. ${toSend.length} email(s) would be sent.`);
    console.error('Run with --send to actually send emails.');
    return;
  }

  // Send mode — dynamically import email service (requires BREVO_API_KEY + env)
  const { sendApiKeyRotationEmail } = await import('../src/services/email.js');

  // Send mode
  const succeeded: KeyEntry[] = [];
  const failed: { entry: KeyEntry; error: string }[] = [];

  for (let i = 0; i < toSend.length; i++) {
    const e = toSend[i];
    try {
      await sendApiKeyRotationEmail(e.email, e.name, e.new_api_key);
      succeeded.push(e);
      console.error(`[${i + 1}/${toSend.length}] OK    ${e.email} (${e.name})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed.push({ entry: e, error: msg });
      console.error(`[${i + 1}/${toSend.length}] FAIL  ${e.email} (${e.name}) — ${msg}`);
    }

    // Throttle between sends (skip after the last one)
    if (i < toSend.length - 1) {
      await sleep(750);
    }
  }

  // Final summary on stderr
  console.error(`\n=== Résumé final ===`);
  console.error(`Total:     ${entries.length}`);
  console.error(`Excluded:  ${excluded.length}`);
  console.error(`Sent OK:   ${succeeded.length}`);
  console.error(`Failed:    ${failed.length}`);

  if (failed.length > 0) {
    console.error(`\nÉchecs (à retraiter manuellement):`);
    for (const f of failed) {
      console.error(`  - ${f.entry.email} (${f.entry.name}) — ${f.error}`);
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
