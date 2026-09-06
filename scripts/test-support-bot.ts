/**
 * Local diagnostic script for the merchant support bot.
 *
 * Run with: npx tsx scripts/test-support-bot.ts
 *
 * This script:
 * 1. Checks if ANTHROPIC_API_KEY is present in the environment
 * 2. Attempts a real API call to Anthropic with the same model and parameters
 *    as the production support bot
 * 3. Prints the full error if the call fails, so you can see exactly what
 *    Anthropic returns (auth error, model deprecation, rate limit, etc.)
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx scripts/test-support-bot.ts
 *
 * Or with a .env file already loaded by Render:
 *   npx tsx scripts/test-support-bot.ts
 */

import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-sonnet-4-5-20250929';
const OLD_MODEL = 'claude-sonnet-4-20250514';

async function testModel(client: Anthropic, model: string): Promise<void> {
  console.log(`\n--- Testing model: ${model} ---`);
  try {
    const response = await client.messages.create({
      model,
      max_tokens: 64,
      system: 'You are a test assistant. Reply briefly.',
      messages: [{ role: 'user', content: 'Hello, just testing. Reply with "OK".' }],
    });
    const textBlock = response.content.find((b) => b.type === 'text');
    console.log(`✅ SUCCESS — model: ${model}`);
    console.log(`   Response: ${textBlock?.text ?? '(no text block)'}`);
    console.log(`   Usage: input=${response.usage.input_tokens}, output=${response.usage.output_tokens}`);
  } catch (err) {
    const errorDetails = {
      name: err instanceof Error ? err.name : 'Unknown',
      message: err instanceof Error ? err.message : String(err),
      status: (err as { status?: number }).status,
      error: (err as { error?: { type?: string; code?: string; message?: string } }).error,
    };
    console.error(`❌ FAILED — model: ${model}`);
    console.error(JSON.stringify(errorDetails, null, 2));
  }
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  console.log('=== Support Bot Diagnostic ===');
  console.log(`ANTHROPIC_API_KEY present: ${apiKey ? 'YES' : 'NO'}`);
  console.log(`ANTHROPIC_API_KEY length: ${apiKey?.length ?? 0}`);
  console.log(`ANTHROPIC_API_KEY prefix: ${apiKey ? apiKey.slice(0, 7) + '...' : 'N/A'}`);

  if (!apiKey) {
    console.error('\n❌ ANTHROPIC_API_KEY is not set in the environment.');
    console.error('   The support bot will escalate ALL messages without attempting an API call.');
    console.error('   Set it with: export ANTHROPIC_API_KEY=sk-ant-...');
    process.exit(1);
  }

  const client = new Anthropic({ apiKey });

  // Test the current model (claude-sonnet-4-5-20250929)
  await testModel(client, MODEL);

  // Also test the old model to see if it was deprecated
  await testModel(client, OLD_MODEL);

  console.log('\n=== Diagnostic complete ===');
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
