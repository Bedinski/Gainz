import type { Config } from '../trading/config.js';
import { buildAllowedTools, buildMcpServers } from './mcp.js';

export interface ToolCallRecord {
  /** MCP-namespaced tool name (e.g. `mcp__unusualwhales__options_flow`). */
  name: string;
  /** Tool input as the model sent it. */
  args: unknown;
  /** Tool output (JSON-serializable). Undefined if the call errored before result. */
  result?: unknown;
  /** Error string if the tool call failed. */
  error?: string;
}

export interface ClaudeResponse {
  text: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  /** iter4 A2: every tool invocation made during the turn, in stream order. */
  toolCalls?: ToolCallRecord[];
  /** Total turn duration in ms, when the SDK reports it. */
  durationMs?: number;
}

export interface ClaudeCompleteArgs {
  systemPrompt: string;
  userPrompt: string;
  /**
   * iter4 B3: per-call model override. Lets multi-model debate dispatch bull
   * to one model and bear to another without instantiating multiple clients.
   * Defaults to `cfg.CLAUDE_MODEL`.
   */
  modelOverride?: string;
  /**
   * iter4 A1: when true, the call is allowed to use MCP-exposed tools
   * (currently UW). The cycle's two heavy stages (`analyze`, `analyzeDip`,
   * post-mortem) opt in; cheap stages (`shortlist`, `debate`) leave it false
   * to avoid latency + cost.
   */
  enableMcpTools?: boolean;
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
    async complete({ systemPrompt, userPrompt, modelOverride, enableMcpTools }) {
      const { query } = await import('@anthropic-ai/claude-agent-sdk');
      const model = modelOverride ?? cfg.CLAUDE_MODEL;
      const mcpServers = enableMcpTools ? buildMcpServers(cfg) : {};
      const allowedTools = enableMcpTools ? buildAllowedTools(cfg) : [];
      let combined = '';
      let promptTokens: number | undefined;
      let completionTokens: number | undefined;
      let durationMs: number | undefined;

      // Tool-call audit (A2). Track tool_use blocks as we see them and pair
      // with tool_result blocks that arrive in subsequent user messages.
      // Map keyed by tool_use_id since blocks within a single message can
      // reference earlier tool_use ids from previous messages.
      const toolUses = new Map<string, { name: string; args: unknown }>();
      const toolResults = new Map<string, { result?: unknown; error?: string }>();

      const iterator = query({
        prompt: userPrompt,
        options: {
          systemPrompt,
          model,
          mcpServers,
          allowedTools,
          // analyze / dip / postmortem need multi-turn so the model can call
          // a tool and then react. shortlist / debate stay maxTurns=1.
          maxTurns: enableMcpTools ? 6 : 1,
        },
      });
      for await (const message of iterator) {
        const m = message as {
          type?: string;
          message?: {
            content?: unknown;
            usage?: { input_tokens?: number; output_tokens?: number };
          };
          content?: unknown;
          duration_ms?: number;
        };
        const usage = m.message?.usage;
        if (usage) {
          if (typeof usage.input_tokens === 'number') promptTokens = usage.input_tokens;
          if (typeof usage.output_tokens === 'number') completionTokens = usage.output_tokens;
        }
        if (m.type === 'result' && typeof m.duration_ms === 'number') durationMs = m.duration_ms;

        const content = m.message?.content ?? m.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          const b = block as Record<string, unknown>;
          const t = b.type;
          if (t === 'text' && typeof b.text === 'string') {
            combined += b.text;
          } else if (t === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
            toolUses.set(b.id, { name: b.name, args: b.input ?? {} });
          } else if (t === 'tool_result' && typeof b.tool_use_id === 'string') {
            const isError = b.is_error === true;
            const payload = b.content;
            toolResults.set(b.tool_use_id, isError ? { error: serialize(payload) } : { result: payload });
          }
        }
      }

      const toolCalls: ToolCallRecord[] = [];
      for (const [id, use] of toolUses) {
        const r = toolResults.get(id);
        toolCalls.push({ name: use.name, args: use.args, result: r?.result, error: r?.error });
      }

      return {
        text: combined.trim(),
        model,
        promptTokens,
        completionTokens,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        durationMs,
      };
    },
  };
}

function serialize(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
