import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

let client: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (!config.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }
  if (!client) {
    client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
    const messages = client.messages;
    const raw = messages.create.bind(messages) as unknown as (b: Body, o?: unknown) => Promise<Anthropic.Message>;
    (messages as unknown as { create: unknown }).create = (body: Body, opts?: unknown) => createCompat(raw, body, opts);
  }
  return client;
}

type Body = Anthropic.MessageCreateParamsNonStreaming;
type Create = (b: Body, o?: unknown) => Promise<Anthropic.Message>;

/** Models that reject a forced tool_choice ("tool"/"any"), learned at runtime. */
const NO_FORCED_TOOL = new Set<string>();

function errInfo(err: unknown): { status?: number; msg: string } {
  return { status: (err as { status?: number }).status, msg: String((err as Error)?.message ?? err) };
}

/**
 * Compatibility layer for every Claude call:
 *  1. Newer models don't support forcing a specific tool. When that's the case
 *     we ask for the tool in the instructions instead (tool_choice "auto"),
 *     and nudge once more if the model answered in plain text.
 *  2. If the API key can't use a model at all (not found / no access), retry
 *     with the next model down.
 */
async function createCompat(raw: Create, body: Body, opts: unknown, depth = 0): Promise<Anthropic.Message> {
  const forced = body.tool_choice && (body.tool_choice.type === 'tool' || body.tool_choice.type === 'any');
  if (forced && NO_FORCED_TOOL.has(body.model)) return createUnforced(raw, body, opts);
  try {
    return await raw(body, opts);
  } catch (err) {
    const { status, msg } = errInfo(err);
    if (forced && status === 400 && /tool_choice/i.test(msg)) {
      NO_FORCED_TOOL.add(body.model);
      console.warn(`[anthropic] ${body.model} doesn't support forced tool_choice; asking for the tool in the prompt instead`);
      return createUnforced(raw, body, opts);
    }
    const fallback = MODEL_FALLBACK[body.model];
    const unavailable =
      status === 404 || status === 403 || (status === 400 && /model/i.test(msg) && !/tool_choice/i.test(msg));
    if (fallback && unavailable && depth < 3) {
      console.warn(`[anthropic] ${body.model} unavailable (${status}); falling back to ${fallback}`);
      return createCompat(raw, { ...body, model: fallback }, opts, depth + 1);
    }
    throw err;
  }
}

async function createUnforced(raw: Create, body: Body, opts: unknown): Promise<Anthropic.Message> {
  const tc = body.tool_choice as { type: string; name?: string };
  const toolName = tc.type === 'tool' && tc.name ? tc.name : null;
  const instruction = toolName
    ? `\n\nIMPORTANT: Give your answer by calling the \`${toolName}\` tool exactly once, with every required field filled. Do not answer in plain text.`
    : '\n\nIMPORTANT: Give your answer by calling one of the provided tools. Do not answer in plain text.';
  const system: Body['system'] =
    typeof body.system === 'string' || body.system == null
      ? (body.system ?? '') + instruction
      : [...body.system, { type: 'text', text: instruction }];
  const next: Body = { ...body, system, tool_choice: { type: 'auto' } };
  const msg = await raw(next, opts);
  const called = msg.content.some((b) => b.type === 'tool_use' && (!toolName || b.name === toolName));
  if (called || msg.stop_reason === 'max_tokens') return msg;
  // Answered in plain text — ask once more, keeping what it already said.
  const followUp: Body = {
    ...next,
    messages: [
      ...next.messages,
      { role: 'assistant', content: msg.content as unknown as Anthropic.ContentBlockParam[] },
      { role: 'user', content: `Now call the ${toolName ?? 'tool'} with your complete answer.` },
    ],
  };
  const second = await raw(followUp, opts);
  return {
    ...second,
    usage: {
      ...second.usage,
      input_tokens: msg.usage.input_tokens + second.usage.input_tokens,
      output_tokens: msg.usage.output_tokens + second.usage.output_tokens,
    },
  };
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
