import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

export const DEFAULT_ENDPOINT = 'https://mcp.hostsherlock.com/v1/mcp';
export const API_KEYS_URL = 'https://www.hostsherlock.com/admin/my/api/keys';

/** JSON-RPC "internal error"; the request never got an answer from the server. */
const PROXY_ERROR_CODE = -32603;

export interface ProxyOptions {
  /** The local side, normally a StdioServerTransport talking to the MCP client. */
  local: Transport;
  endpoint?: URL;
  apiKey?: string;
  userAgent: string;
  fetch?: FetchLike;
  /** Where diagnostics go. stdout belongs to the protocol, so the CLI passes stderr. */
  log?: (line: string) => void;
}

export interface RunningProxy {
  remote: StreamableHTTPClientTransport;
  /** Resolves once either side has closed and the other one was closed after it. */
  closed: Promise<void>;
  close(): Promise<void>;
}

/**
 * Relays JSON-RPC messages unchanged between a local transport and the
 * HostSherlock MCP endpoint. It holds no tool definitions of its own: every
 * tool, its schema and its answer come from the remote server.
 */
export async function startProxy(opts: ProxyOptions): Promise<RunningProxy> {
  const log = opts.log ?? (() => {});
  const headers: Record<string, string> = { 'User-Agent': opts.userAgent };
  if (opts.apiKey) {
    headers['Authorization'] = `Bearer ${opts.apiKey}`;
  }

  const remote = new StreamableHTTPClientTransport(opts.endpoint ?? new URL(DEFAULT_ENDPOINT), {
    requestInit: { headers },
    fetch: opts.fetch,
  });
  const local = opts.local;
  const hasKey = Boolean(opts.apiKey);

  // The HTTP transport sends MCP-Protocol-Version only once it is told the
  // negotiated version. A full Client sets it after initialize; a relay has to
  // read it off the initialize response itself.
  const pendingInitialize = new Set<string | number>();

  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));
  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return closed;
    closing = true;
    await Promise.allSettled([remote.close(), local.close()]);
    resolveClosed();
  };

  local.onmessage = (message: JSONRPCMessage) => {
    if (isRequest(message) && message.method === 'initialize') {
      pendingInitialize.add(message.id);
    }
    // remote.onerror has already logged the failure; this only answers the request.
    remote.send(message).catch((error: unknown) => {
      if (isRequest(message)) {
        pendingInitialize.delete(message.id);
        local
          .send({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: PROXY_ERROR_CODE, message: describe(error, hasKey) },
          })
          .catch(() => {});
      }
    });
  };

  remote.onmessage = (message: JSONRPCMessage) => {
    if (isResponse(message) && pendingInitialize.delete(message.id)) {
      const version = (message as { result?: { protocolVersion?: unknown } }).result?.protocolVersion;
      if (typeof version === 'string') {
        remote.setProtocolVersion(version);
      }
    }
    local.send(message).catch((error: unknown) => log(`hostsherlock-mcp: ${describe(error, hasKey)}`));
  };

  remote.onerror = (error) => log(`hostsherlock-mcp: ${describe(error, hasKey)}`);
  local.onerror = (error) => log(`hostsherlock-mcp: ${describe(error, hasKey)}`);
  remote.onclose = () => void close();
  local.onclose = () => void close();

  await remote.start();
  await local.start();

  return { remote, closed, close };
}

/** Turns a transport error into one sentence the MCP client can show. */
export function describe(error: unknown, hasKey: boolean): string {
  if (error instanceof StreamableHTTPError && error.code === 401 && !hasKey) {
    return `HostSherlock needs an API key. Set HOSTSHERLOCK_API_KEY to a key from ${API_KEYS_URL}.`;
  }
  if (error instanceof StreamableHTTPError && error.code === 401) {
    return `HostSherlock did not accept the API key. Set HOSTSHERLOCK_API_KEY to a key from ${API_KEYS_URL}.`;
  }
  if (error instanceof StreamableHTTPError && error.code === 403) {
    return `HostSherlock refused the request (403). Check the key's permissions at ${API_KEYS_URL}.`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isRequest(message: JSONRPCMessage): message is JSONRPCMessage & { id: string | number; method: string } {
  return 'method' in message && 'id' in message && message.id !== undefined;
}

function isResponse(message: JSONRPCMessage): message is JSONRPCMessage & { id: string | number } {
  return !('method' in message) && 'id' in message && message.id !== undefined;
}
