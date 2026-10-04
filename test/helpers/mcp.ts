import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import type { Runtime } from '../../src/core/types';

export interface ToolCallResult {
  /** `structuredContent`, when the tool returned one. */
  structured: Record<string, unknown> | undefined;
  /** The text blocks joined. */
  text: string;
  isError: boolean;
}

export interface TestClient {
  client: Client;
  tools(): Promise<Array<{ name: string; annotations?: Record<string, unknown> }>>;
  call(name: string, args?: Record<string, unknown>): Promise<ToolCallResult>;
  close(): Promise<void>;
}

/** A real MCP client talking to a real server in memory, with the given tools registered. */
export async function connectTools(
  runtime: Runtime,
  ...registers: Array<(server: McpServer, runtime: Runtime) => void>
): Promise<TestClient> {
  const server = new McpServer({ name: 'test', version: '0.0.0' }, { capabilities: { tools: {} } });
  for (const register of registers) register(server, runtime);
  return connectServer(server);
}

export interface ConnectOptions {
  /** Declares the elicitation capability and answers every confirmation prompt with this function. */
  elicit?: (message: string) => { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, boolean> };
}

export async function connectServer(server: McpServer, options: ConnectOptions = {}): Promise<TestClient> {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const elicit = options.elicit;
  const client = new Client(
    { name: 'test-client', version: '0.0.0' },
    elicit === undefined ? {} : { capabilities: { elicitation: {} } },
  );
  if (elicit !== undefined) {
    client.setRequestHandler('elicitation/create', async (request) => elicit(String(request.params.message)));
  }
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return {
    client,
    async tools() {
      const listed = await client.listTools();
      return listed.tools as Array<{ name: string; annotations?: Record<string, unknown> }>;
    },
    async call(name, args = {}) {
      const result = (await client.callTool({ name, arguments: args })) as {
        content?: Array<{ type: string; text?: string }>;
        structuredContent?: Record<string, unknown>;
        isError?: boolean;
      };
      return {
        structured: result.structuredContent,
        text: (result.content ?? []).map((block) => block.text ?? '').join('\n'),
        isError: result.isError === true,
      };
    },
    close: () => client.close(),
  };
}
