import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

let client: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (!config.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }
  if (!client) {
    client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  }
  return client;
}

// Sonnet 4.6 is the default — best balance of reasoning depth and cost for
// pattern recognition + structured tool-use on chart data. Fable 5 is the
// deep-dive model when you want the strongest analysis available.
export const FAST_MODEL = 'claude-sonnet-4-6';
export const DEEP_MODEL = 'claude-fable-5';

export type ModelTier = 'fast' | 'deep';

export function resolveModel(tier: ModelTier = 'fast'): string {
  return tier === 'deep' ? DEEP_MODEL : FAST_MODEL;
}

export function isAnthropicConfigured(): boolean {
  return !!config.ANTHROPIC_API_KEY;
}
