import type { Config } from '../trading/config.js';

export interface ClaudeResponse {
  text: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
}

export interface ClaudeClient {
  complete(args: { systemPrompt: string; userPrompt: string }): Promise<ClaudeResponse>;
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
    async complete({ systemPrompt, userPrompt }) {
      const { query } = await import('@anthropic-ai/claude-agent-sdk');
      let combined = '';
      let promptTokens: number | undefined;
      let completionTokens: number | undefined;
      const iterator = query({
        prompt: userPrompt,
        options: {
          systemPrompt,
          model: cfg.CLAUDE_MODEL,
          // Pure text-out, no tools. The bot makes its own deterministic decisions
          // about ordering — Claude only proposes.
          allowedTools: [],
          maxTurns: 1,
        },
      });
      for await (const message of iterator) {
        // The SDK streams typed messages. We collect text deltas.
        // Using a permissive any-shape guard since SDK schema may evolve.
        const m = message as { type?: string; message?: { content?: unknown; usage?: { input_tokens?: number; output_tokens?: number } }; content?: unknown };
        const usage = m.message?.usage;
        if (usage) {
          if (typeof usage.input_tokens === 'number') promptTokens = usage.input_tokens;
          if (typeof usage.output_tokens === 'number') completionTokens = usage.output_tokens;
        }
        const content = m.message?.content ?? m.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block && typeof block === 'object' && 'text' in block && typeof (block as { text: unknown }).text === 'string') {
              combined += (block as { text: string }).text;
            }
          }
        }
      }
      return {
        text: combined.trim(),
        model: cfg.CLAUDE_MODEL,
        promptTokens,
        completionTokens,
      };
    },
  };
}
