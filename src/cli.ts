#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DEFAULT_ENDPOINT, startProxy } from './proxy.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
const log = (line: string) => process.stderr.write(line + '\n');

const endpoint = new URL(process.env.HOSTSHERLOCK_MCP_URL || DEFAULT_ENDPOINT);
if (endpoint.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) {
  log(`hostsherlock-mcp: refusing to send the API key over ${endpoint.protocol} to ${endpoint.host}.`);
  process.exit(1);
}

const proxy = await startProxy({
  local: new StdioServerTransport(),
  endpoint,
  apiKey: process.env.HOSTSHERLOCK_API_KEY?.trim() || undefined,
  userAgent: `hostsherlock-mcp/${pkg.version} (node ${process.version})`,
  log,
});

process.stdin.on('end', () => void proxy.close());
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void proxy.close());
}
await proxy.closed;
process.exit(0);
