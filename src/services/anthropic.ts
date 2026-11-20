import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

let client: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (!config.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }
  if (!client) {
    client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
    // If the API key can't use a model (not found / no access), retry once
    // with the next model down instead of failing the request.
    const messages = client.messages;
    const create = messages.create.bind(messages);
    (messages as unknown as { create: typeof create }).create = (async (body: Parameters<typeof create>[0], opts?: Parameters<typeof create>[1]) => {
      try {
        return await create(body, opts);
      } catch (err) {
        const status = (err as { status?: number }).status;
        const fallback = MODEL_FALLBACK[body.model as string];
        if (fallback && (status === 404 || status === 403 || /model/i.test(String((err as Error).message)) && status === 400)) {
          console.warn(`[anthropic] ${body.model} unavailable (${status}); falling back to ${fallback}`);
          return await create({ ...body, model: fallback }, opts);
        }
        throw err;
      }
    }) as typeof create;
  }
  return client;
}

const MODEL_FALLBACK: Record<string, string> = {
  'claude-fable-5-1': 'claude-opus-5-5',
  'claude-opus-5-5': 'claude-sonnet-5-5',
  'claude-sonnet-5-5': 'claude-sonnet-4-6',
};

// Opus 5.5 is the default: strongest everyday reasoning for reading charts,
// news and the measured setups. Fable 5.1 (Mythos tier) is the deep dive.
// Note: trade conviction is capped by each setup's measured track record
// (quant.ts convictionFromStats), whichever model writes the analysis.
export const FAST_MODEL = 'claude-opus-5-5';
export const DEEP_MODEL = 'claude-fable-5-1';

export type ModelTier = 'fast' | 'deep';

export function resolveModel(tier: ModelTier = 'fast'): string {
  return tier === 'deep' ? DEEP_MODEL : FAST_MODEL;
}

export function isAnthropicConfigured(): boolean {
  return !!config.ANTHROPIC_API_KEY;
}
