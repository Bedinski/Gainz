import { describe, it, expect, beforeEach } from 'vitest';
import { buildUwMcpServer, buildMcpServers, buildAllowedTools } from '../src/claude/mcp.js';
import { clearConfigCacheForTests, loadConfig } from '../src/trading/config.js';

const baseEnv = {
  TRADING_MODE: 'paper',
  SYMBOL_ALLOWLIST: 'AAPL',
  SQLITE_PATH: ':memory:',
} as unknown as NodeJS.ProcessEnv;

beforeEach(() => clearConfigCacheForTests());

describe('UW MCP server descriptor', () => {
  it('returns null when UW_MCP_ENABLED is false (default)', () => {
    const cfg = loadConfig(baseEnv);
    expect(buildUwMcpServer(cfg)).toBeNull();
    expect(buildMcpServers(cfg)).toEqual({});
    expect(buildAllowedTools(cfg)).toEqual([]);
  });

  it('returns null when enabled but UW_API_KEY is missing (fail-soft)', () => {
    const cfg = loadConfig({
      ...baseEnv,
      UW_MCP_ENABLED: 'true',
    } as unknown as NodeJS.ProcessEnv);
    expect(buildUwMcpServer(cfg)).toBeNull();
    expect(buildAllowedTools(cfg)).toEqual([]);
  });

  it('builds the descriptor when enabled with API key', () => {
    const cfg = loadConfig({
      ...baseEnv,
      UW_MCP_ENABLED: 'true',
      UW_API_KEY: 'uw_test_key',
    } as unknown as NodeJS.ProcessEnv);
    const desc = buildUwMcpServer(cfg);
    expect(desc).not.toBeNull();
    expect(desc!.command).toBe('npx');
    expect(desc!.args).toContain('unusual-whales-mcp');
    expect(desc!.env.UW_API_KEY).toBe('uw_test_key');
    expect(buildMcpServers(cfg)).toEqual({ unusualwhales: desc });
    expect(buildAllowedTools(cfg)).toEqual(['mcp__unusualwhales__*']);
  });

  it('respects UW_MCP_BINARY override (custom path, no args)', () => {
    const cfg = loadConfig({
      ...baseEnv,
      UW_MCP_ENABLED: 'true',
      UW_API_KEY: 'k',
      UW_MCP_BINARY: '/usr/local/bin/uw-mcp',
    } as unknown as NodeJS.ProcessEnv);
    const desc = buildUwMcpServer(cfg)!;
    expect(desc.command).toBe('/usr/local/bin/uw-mcp');
    expect(desc.args).toEqual([]);
  });

  it('respects UW_MCP_BINARY override with multiple args', () => {
    const cfg = loadConfig({
      ...baseEnv,
      UW_MCP_ENABLED: 'true',
      UW_API_KEY: 'k',
      UW_MCP_BINARY: 'node /opt/mcp/server.js --verbose',
    } as unknown as NodeJS.ProcessEnv);
    const desc = buildUwMcpServer(cfg)!;
    expect(desc.command).toBe('node');
    expect(desc.args).toEqual(['/opt/mcp/server.js', '--verbose']);
  });
});
