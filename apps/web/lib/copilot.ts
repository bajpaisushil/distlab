import type Anthropic from '@anthropic-ai/sdk';

/**
 * The only code in DistLab that talks to an AI provider. It runs only when
 * the user presses Send, with their own API key, directly from the browser
 * to Anthropic — there is no DistLab server in between. The SDK is loaded on
 * first use, so the lab never downloads it unless AI is used.
 */

export const COPILOT_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
] as const;
export type CopilotModel = (typeof COPILOT_MODELS)[number]['id'];

export interface CopilotCall {
  readonly apiKey: string;
  readonly model: CopilotModel;
  readonly system: string;
  readonly schema: Record<string, unknown>;
  readonly messages: Anthropic.Beta.BetaMessageParam[];
  readonly effort: 'low' | 'medium' | 'high';
}

export type CopilotReply =
  | {
      readonly ok: true;
      /** The structured answer, parsed but not yet checked. */
      readonly json: unknown;
      /** The full response content, to append unchanged if the conversation continues. */
      readonly content: Anthropic.Beta.BetaContentBlock[];
      readonly model: string;
      readonly usage: { readonly input: number; readonly output: number };
    }
  | { readonly ok: false; readonly error: string };

export async function askClaude(call: CopilotCall): Promise<CopilotReply> {
  const { default: AnthropicClient } = await import('@anthropic-ai/sdk');
  // The key is the user's own and stays in their browser; this flag is the SDK's acknowledgement of that.
  const client = new AnthropicClient({ apiKey: call.apiKey, dangerouslyAllowBrowser: true });
  try {
    const response = await client.beta.messages.create({
      model: call.model,
      max_tokens: 16000,
      // If a safety classifier declines, retry on Anthropic's recommended fallback model rather than fail.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [{ type: 'text', text: call.system, cache_control: { type: 'ephemeral' } }],
      output_config: { effort: call.effort, format: { type: 'json_schema', schema: call.schema } },
      messages: call.messages,
    });
    if (response.stop_reason === 'refusal') return { ok: false, error: 'Claude declined to answer this request.' };
    if (response.stop_reason === 'max_tokens') return { ok: false, error: 'The answer was cut off before it finished. Try a narrower question.' };
    const text = response.content
      .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, error: 'The answer was not valid JSON.' };
    }
    return {
      ok: true,
      json,
      content: response.content,
      model: response.model,
      usage: { input: response.usage.input_tokens, output: response.usage.output_tokens },
    };
  } catch (error) {
    if (error instanceof AnthropicClient.AuthenticationError) return { ok: false, error: 'Anthropic rejected the API key.' };
    if (error instanceof AnthropicClient.PermissionDeniedError) return { ok: false, error: 'This API key is not allowed to use that model.' };
    if (error instanceof AnthropicClient.RateLimitError) return { ok: false, error: 'Rate limited by Anthropic — wait a moment and try again.' };
    if (error instanceof AnthropicClient.BadRequestError) return { ok: false, error: `Anthropic rejected the request: ${error.message}` };
    if (error instanceof AnthropicClient.APIConnectionError) return { ok: false, error: 'Could not reach api.anthropic.com from this browser.' };
    if (error instanceof AnthropicClient.APIError) return { ok: false, error: `Anthropic error ${error.status ?? ''}: ${error.message}` };
    return { ok: false, error: error instanceof Error ? error.message : 'Something went wrong.' };
  }
}

const KEY_STORAGE = 'distlab.anthropicKey';

/** A key the user chose to remember on this device. Never stored unless they ask. */
export function rememberedKey(): string {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
}

export function rememberKey(key: string | null): void {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    // Storage blocked: the key simply is not remembered.
  }
}
