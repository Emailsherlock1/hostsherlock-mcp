import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const KEY = 'test-key-123';

/**
 * A stand-in for mcp.hostsherlock.com: Streamable HTTP with sessions, 401
 * without the right Bearer key, one tool. It records what the relay sent.
 */
async function startUpstream() {
  const seen = { authorization: [], protocolVersion: [], userAgent: [] };
  const transports = new Map();
  const http = createServer(async (req, res) => {
    seen.authorization.push(req.headers.authorization);
    seen.protocolVersion.push(req.headers['mcp-protocol-version']);
    seen.userAgent.push(req.headers['user-agent']);
    if (req.headers.authorization !== `Bearer ${KEY}`) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' });
      res.end('{"error":{"code":"unauthorized","message":"Missing API key."}}');
      return;
    }
    const sid = req.headers['mcp-session-id'];
    let transport = sid ? transports.get(sid) : undefined;
    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => transports.set(id, transport),
      });
      const server = new McpServer({ name: 'HostSherlock', version: '9.9.9' });
      server.registerTool(
        'echo_domain',
        { description: 'Echoes a domain', inputSchema: { domain: z.string() } },
        async ({ domain }) => ({ content: [{ type: 'text', text: `checked ${domain}` }] }),
      );
      await server.connect(transport);
    }
    await transport.handleRequest(req, res);
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${http.address().port}/v1/mcp`;
  // closeAllConnections: the relay keeps a GET stream open, which http.close() would wait for.
  const stop = () => new Promise((resolve) => {
    http.closeAllConnections();
    http.close(resolve);
  });
  return { url, seen, stop };
}

async function connect(url, apiKey) {
  const env = { ...process.env, HOSTSHERLOCK_MCP_URL: url };
  delete env.HOSTSHERLOCK_API_KEY;
  if (apiKey) env.HOSTSHERLOCK_API_KEY = apiKey;
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI], env, stderr: 'pipe' });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  return { client, transport };
}

test('relays initialize, tools/list and tools/call to the remote server', async (t) => {
  const upstream = await startUpstream();
  t.after(upstream.stop);
  const { client, transport } = await connect(upstream.url, KEY);
  await client.connect(transport);
  t.after(() => client.close());

  assert.equal(client.getServerVersion().name, 'HostSherlock');
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ['echo_domain']);
  const result = await client.callTool({ name: 'echo_domain', arguments: { domain: 'example.com' } });
  assert.equal(result.content[0].text, 'checked example.com');

  assert.ok(upstream.seen.authorization.every((value) => value === `Bearer ${KEY}`));
  assert.match(upstream.seen.userAgent[0], /^hostsherlock-mcp\/\d+\.\d+\.\d+ /);
  // Every request after initialize carries the negotiated version.
  assert.equal(upstream.seen.protocolVersion[0], undefined);
  assert.ok(upstream.seen.protocolVersion.slice(1).every((value) => typeof value === 'string' && value.length > 0));
});

test('answers initialize with an error that names the missing key', async (t) => {
  const upstream = await startUpstream();
  t.after(upstream.stop);
  const { client, transport } = await connect(upstream.url, undefined);
  t.after(() => client.close());
  await assert.rejects(client.connect(transport), /HostSherlock needs an API key\. Set HOSTSHERLOCK_API_KEY/);
});

test('answers initialize with an error that names a rejected key', async (t) => {
  const upstream = await startUpstream();
  t.after(upstream.stop);
  const { client, transport } = await connect(upstream.url, 'wrong-key');
  t.after(() => client.close());
  await assert.rejects(client.connect(transport), /HostSherlock did not accept the API key/);
});

test('refuses to send the key over plain http to a remote host', async () => {
  const child = spawn(process.execPath, [CLI], {
    env: { ...process.env, HOSTSHERLOCK_MCP_URL: 'http://mcp.example.com/v1/mcp', HOSTSHERLOCK_API_KEY: KEY },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 1);
  assert.match(stderr, /refusing to send the API key over http:/);
});
