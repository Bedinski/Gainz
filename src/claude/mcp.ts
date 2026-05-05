import type { Config } from '../trading/config.js';

/**
 * iter4 A1: Unusual Whales MCP server descriptor.
 *
 * The agent SDK speaks MCP natively via `mcpServers` in `query()` options.
 * This module returns a single-server config (UW only for iter4) when the
 * feature flag is set; otherwise an empty map (zero MCP overhead).
 *
 * Server discovery: defaults to the `unusual-whales-mcp` community npm
 * package launched via `npx`. Operators can override with UW_MCP_BINARY to
 * point at the official UW binary or a custom path.
 *
 * Authentication: UW_API_KEY is forwarded to the spawned process via env.
 * The server picks it up from `process.env.UW_API_KEY` per UW's MCP docs.
 */
export interface McpServerDescriptor {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function buildUwMcpServer(cfg: Config): McpServerDescriptor | null {
  if (!cfg.UW_MCP_ENABLED) return null;
  if (!cfg.UW_API_KEY) {
    // Fail-soft: emit no descriptor when the API key is missing. Caller logs
    // a warning. We don't throw — the cycle should keep running on baseline
    // signals while the operator fixes their env.
    return null;
  }
  // UW_MCP_BINARY defaults to "npx -y unusual-whales-mcp" — split on first
  // space so we get command + args correctly. Operators can override with a
  // custom path like "/usr/local/bin/uw-mcp" (no args).
  const tokens = cfg.UW_MCP_BINARY.trim().split(/\s+/);
  const command = tokens[0]!;
  const args = tokens.slice(1);
  return {
    command,
    args,
    env: { UW_API_KEY: cfg.UW_API_KEY, UW_TOKEN: cfg.UW_API_KEY },
  };
}

/** Build the `mcpServers` map for the agent SDK. Empty when UW is disabled. */
export function buildMcpServers(cfg: Config): Record<string, McpServerDescriptor> {
  const uw = buildUwMcpServer(cfg);
  if (!uw) return {};
  return { unusualwhales: uw };
}

/**
 * Allowed-tool patterns for an MCP-enabled call site. The agent SDK enforces
 * these; tools outside this list won't be exposed even if the server lists them.
 *
 * Pattern format: `mcp__<server-name>__<tool-name>`. Use `*` to allow all
 * tools from a server. We allow all UW tools because the model picks per-call
 * which subset to query — restricting at the server boundary is simpler and
 * matches how the SDK exposes them.
 */
export function buildAllowedTools(cfg: Config): string[] {
  if (!cfg.UW_MCP_ENABLED || !cfg.UW_API_KEY) return [];
  return ['mcp__unusualwhales__*'];
}
