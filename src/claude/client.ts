import type { Config } from '../trading/config.js';

export interface ClaudeResponse {
  text: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
}

export interface ClaudeCompleteArgs {
  systemPrompt: string;
  userPrompt: string;
  /**
   * Per-call model override. Lets multi-model debate dispatch bull to one model
   * and bear to another without instantiating multiple clients. Defaults to
   * `cfg.CLAUDE_MODEL`.
   */
  modelOverride?: string;
}

export interface ClaudeClient {
  complete(args: ClaudeCompleteArgs): Promise<ClaudeResponse>;
}

/**
 * Real client uses @anthropic-ai/claude-agent-sdk, which authenticates via
 * the user's existing Claude Max OAuth token (no API key, no extra billing).
 * The token persists at $CLAUDE_AUTH_DIR.
 *
 * We isolate the SDK behind this thin interface so:
 *   1. Tests inject a mock with no network/SDK dependency.
 *   2. Swapping to @anthropic-ai/sdk (API billing) later is a one-file change.
 */
export function createSdkClient(cfg: Config): ClaudeClient {
  return {
    async complete({ systemPrompt, userPrompt, modelOverride }) {
      const { query } = await import('@anthropic-ai/claude-agent-sdk');
      const model = modelOverride ?? cfg.CLAUDE_MODEL;
      let combined = '';
      let promptTokens: number | undefined;
      let completionTokens: number | undefined;

      const iterator = query({
        prompt: userPrompt,
        options: {
          systemPrompt,
          model,
          maxTurns: 1,
        },
      });
      for await (const message of iterator) {
        const m = message as {
          message?: {
            content?: unknown;
            usage?: { input_tokens?: number; output_tokens?: number };
          };
          content?: unknown;
        };
        const usage = m.message?.usage;
        if (usage) {
          if (typeof usage.input_tokens === 'number') promptTokens = usage.input_tokens;
          if (typeof usage.output_tokens === 'number') completionTokens = usage.output_tokens;
        }

        const content = m.message?.content ?? m.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          const b = block as Record<string, unknown>;
          if (b.type === 'text' && typeof b.text === 'string') {
            combined += b.text;
          }
        }
      }

      return {
        text: combined.trim(),
        model,
        promptTokens,
        completionTokens,
      };
    },
  };
}
