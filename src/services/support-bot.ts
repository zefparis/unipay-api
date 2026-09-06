import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env.js';

const SYSTEM_PROMPT = `Tu es l'assistant de support UniPay Congo, une plateforme de paiement Mobile Money en RDC.

RÔLE:
- Répondre aux questions des marchands connectés à leur tableau de bord
- Aider avec l'utilisation de l'API, le statut KYC, les clés API, les transactions
- Ton professionnel, courtois, concis — réponds en français par défaut

RÈGLES CRITIQUES:
- Tu ne vois QUE les données du marchand qui te parle (fournies dans le contexte)
- Ne JAMAIS mentionner ou révéler des données d'autres marchands
- Si la question dépasse ce que les données fournies permettent de répondre, dis-le clairement
- Si le marchand demande explicitement un humain, ou si la question nécessite une action manuelle
  (ex: modification de compte, problème de facturation, litige), réponds:
  "Un membre de notre équipe va prendre le relais et vous répondre sous peu."
  et mets le mot-clé [ESCALATE] au tout début de ta réponse.

FORMAT:
- Réponses courtes et directes (max 3-4 paragraphes)
- Utilise le contexte fourni pour répondre précisément
- Si tu ne sais pas, dis-le — ne invente jamais d'informations`;

// Use the latest model known to the installed SDK (0.124.0).
// claude-sonnet-4-20250514 was the original Sonnet 4 release and may be deprecated.
// claude-sonnet-4-5-20250929 is the current Sonnet 4.5 release.
const MODEL = 'claude-sonnet-4-5-20250929';

let keyPresenceLogged = false;

function getClient(): Anthropic | null {
  if (!env.ANTHROPIC_API_KEY) {
    // Log the absence once at startup, then silently return null on subsequent calls.
    // We log the boolean presence, NEVER the key value itself.
    if (!keyPresenceLogged) {
      console.log('[support-bot] ANTHROPIC_API_KEY: absent — bot will escalate all messages');
      keyPresenceLogged = true;
    }
    return null;
  }
  if (!keyPresenceLogged) {
    console.log('[support-bot] ANTHROPIC_API_KEY: present — bot will attempt API calls');
    keyPresenceLogged = true;
  }
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

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

function buildContextBlock(ctx: MerchantContext): string {
  const txLines = ctx.recent_transactions.length > 0
    ? ctx.recent_transactions.map((t) =>
        `- ${t.created_at}: ${t.direction} ${t.operator} ${t.amount} ${t.currency} (${t.status})`,
      ).join('\n')
    : 'Aucune transaction récente';

  return `CONTEXTE DU MARCHAND (données privées — ne jamais partager avec d'autres):
- Nom: ${ctx.name}
- Email: ${ctx.email}
- Entreprise: ${ctx.company_name ?? 'N/A'}
- Statut KYC: ${ctx.kyc_status}
- Mode: ${ctx.mode}
- Statut du compte: ${ctx.status}
- Clé API active: ${ctx.api_key_active ? 'Oui' : 'Non'}
- 10 dernières transactions:
${txLines}`;
}

export async function generateBotReply(
  conversationHistory: Array<{ role: 'merchant' | 'bot' | 'admin'; content: string }>,
  merchantContext: MerchantContext,
): Promise<BotResponse> {
  const client = getClient();
  if (!client) {
    // No API key — escalate immediately
    return {
      content: 'Un membre de notre équipe va prendre le relais et vous répondre sous peu.',
      escalated: true,
    };
  }

  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = conversationHistory.map((m) => ({
    role: m.role === 'merchant' ? 'user' as const : 'assistant' as const,
    content: m.content,
  }));

  console.log(`[support-bot] Attempting Anthropic API call — model: ${MODEL}, messages: ${messages.length}`);

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: `${SYSTEM_PROMPT}\n\n${buildContextBlock(merchantContext)}`,
      messages,
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    const content = textBlock?.text ?? 'Désolé, je n\'ai pas pu traiter votre demande.';

    const escalated = content.startsWith('[ESCALATE]');
    const cleanContent = escalated ? content.replace('[ESCALATE]', '').trim() : content;

    console.log(`[support-bot] API call succeeded — escalated: ${escalated}, response length: ${content.length}`);
    return { content: cleanContent, escalated };
  } catch (err) {
    // Log the FULL error details — never swallow silently.
    // This is the critical diagnostic path: if the API call fails, we need
    // to see the exact error code, message, and SDK details.
    const errorDetails = {
      name: err instanceof Error ? err.name : 'Unknown',
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      // Anthropic SDK errors include status, error.code, error.message, error.type
      status: (err as { status?: number }).status,
      error: (err as { error?: { type?: string; code?: string; message?: string } }).error,
      // Log the model that was attempted, to catch deprecation issues
      model: MODEL,
    };
    console.error('[support-bot] Anthropic API call FAILED:', JSON.stringify(errorDetails, null, 2));

    return {
      content: 'Une erreur technique est survenue. Un membre de notre équipe va prendre le relais et vous répondre sous peu.',
      escalated: true,
    };
  }
}
