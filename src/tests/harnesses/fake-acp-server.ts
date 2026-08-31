import { chmodSync, writeFileSync } from "node:fs";

export interface FakeAcpServerOptions {
  sessionId?: string;
  marker?: string;
  toolTitle?: string;
  toolInput?: string;
  toolOutput?: string;
  includeConfigEcho?: boolean;
  // When true the fake agent advertises the ACP image prompt capability at
  // initialize and echoes back what image content blocks it received, so a
  // harness can assert the runtime forwards image blocks.
  promptImage?: boolean;
  usageUsed?: number;
  usageSize?: number;
  compactUsageUsed?: number;
  thoughtText?: string;
  sessionSetupRecordPath?: string;
  notificationRecordPath?: string;
  mcpToolCall?: {
    name: string;
    arguments?: Record<string, unknown>;
  };
}

export interface FakeAcpCommandOptions extends FakeAcpServerOptions {
  commandName?: string;
  version?: string;
  acpSubcommand?: string;
  serveScriptPath?: string;
}

export function writeFakeAcpServer(path: string, options: FakeAcpServerOptions = {}): void {
  writeFileSync(path, fakeAcpServerSource(options), "utf8");
}

export function writeFakeAcpCommand(path: string, serverPath: string, options: FakeAcpCommandOptions = {}): void {
  const version = options.version ?? `${options.commandName ?? "fake-acp"} 0.0.0`;
  const acpSubcommand = options.acpSubcommand ?? "acp";
  if (process.platform === "win32") {
    writeFileSync(
      path,
      [
        "import { pathToFileURL } from 'node:url';",
        `const version = ${JSON.stringify(version)};`,
        `const acpSubcommand = ${JSON.stringify(acpSubcommand)};`,
        `const serverPath = ${JSON.stringify(serverPath)};`,
        `const serveScriptPath = ${JSON.stringify(options.serveScriptPath)};`,
        "const [subcommand] = process.argv.slice(2);",
        "if (subcommand === '--version') { process.stdout.write(`${version}\\n`); process.exit(0); }",
        "const script = subcommand === acpSubcommand ? serverPath : subcommand === 'serve' ? serveScriptPath : undefined;",
        "if (!script) { process.stderr.write(`unexpected fake ACP command invocation: ${process.argv.slice(2).join(' ')}\\n`); process.exit(2); }",
        "await import(pathToFileURL(script).href);",
      ].join("\n"),
      "utf8",
    );
    return;
  }
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then',
      `  echo ${JSON.stringify(version)}`,
      "  exit 0",
      "fi",
      ...(options.serveScriptPath
        ? [
            'if [ "$1" = "serve" ]; then',
            `  exec ${JSON.stringify(process.execPath)} ${JSON.stringify(options.serveScriptPath)} "$@"`,
            "fi",
          ]
        : []),
      `if [ "$1" = ${JSON.stringify(acpSubcommand)} ]; then`,
      `  exec ${JSON.stringify(process.execPath)} ${JSON.stringify(serverPath)}`,
      "fi",
      'echo "unexpected fake ACP command invocation: $*" >&2',
      "exit 2",
    ].join("\n"),
    "utf8",
  );
  chmodSync(path, 0o755);
}

export function writeFakeOpenCodeServe(path: string, options: { recordPath: string }): void {
  writeFileSync(
    path,
    [
      "import { appendFileSync } from 'node:fs';",
      "import http from 'node:http';",
      `const recordPath = ${JSON.stringify(options.recordPath)};`,
      "function send(response, status, value) {",
      "  response.writeHead(status, { 'content-type': 'application/json' });",
      "  response.end(JSON.stringify(value));",
      "}",
      "async function readBody(request) {",
      "  const chunks = [];",
      "  for await (const chunk of request) chunks.push(chunk);",
      "  const text = Buffer.concat(chunks).toString('utf8');",
      "  return text ? JSON.parse(text) : {};",
      "}",
      "const server = http.createServer(async (request, response) => {",
      "  const url = new URL(request.url || '/', 'http://127.0.0.1');",
      "  if (request.method === 'GET' && url.pathname === '/config/providers') {",
      "    send(response, 200, { providers: [], default: { 'fake-provider': 'fake-model' } });",
      "    return;",
      "  }",
      "  const summarize = url.pathname.match(/^\\/session\\/([^/]+)\\/summarize$/);",
      "  if (request.method === 'POST' && summarize) {",
      "    const body = await readBody(request);",
      "    appendFileSync(recordPath, JSON.stringify({ sessionId: summarize[1], body }) + '\\n');",
      "    send(response, 200, true);",
      "    return;",
      "  }",
      "  send(response, 404, { error: 'not_found', path: url.pathname });",
      "});",
      "server.listen(0, '127.0.0.1', () => {",
      "  const address = server.address();",
      "  process.stdout.write(`listening on http://127.0.0.1:${address.port}\\n`);",
      "});",
      "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
    ].join("\n"),
    "utf8",
  );
}

export function fakeAcpServerSource(options: FakeAcpServerOptions = {}): string {
  const sessionId = options.sessionId ?? "fake-acp-session";
  const marker = options.marker ?? "FAKE_ACP_OK";
  const toolTitle = options.toolTitle ?? "terminal: printf OK";
  const toolInput = options.toolInput ?? "printf OK";
  const toolOutput = options.toolOutput ?? "OK";
  return [
    "import { createInterface } from 'node:readline';",
    "import { appendFileSync, readFileSync, existsSync } from 'node:fs';",
    "import { spawn } from 'node:child_process';",
    "import { resolve } from 'node:path';",
    "const rl = createInterface({ input: process.stdin });",
    "let mcpProcess;",
    "let mcpNextId = 1;",
    "const mcpPending = new Map();",
    "function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }",
    "function mcpSend(message) { mcpProcess.stdin.write(`${JSON.stringify(message)}\\n`); }",
    "function mcpRequest(method, params) {",
    "  const id = mcpNextId++;",
    "  mcpSend({ jsonrpc: '2.0', id, method, params });",
    "  return new Promise((resolvePromise, reject) => mcpPending.set(id, { resolvePromise, reject }));",
    "}",
    "async function startMcp(config) {",
    "  if (mcpProcess) return;",
    "  if (!config || config.type !== 'stdio') throw new Error('fake_acp_mcp_server_missing');",
    "  const extraEnv = Object.fromEntries((config.env || []).map((entry) => [entry.name, entry.value]));",
    "  mcpProcess = spawn(config.command, config.args || [], { env: { ...process.env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });",
    "  const mcpLines = createInterface({ input: mcpProcess.stdout });",
    "  void (async () => {",
    "    for await (const line of mcpLines) {",
    "      if (!line.trim()) continue;",
    "      const message = JSON.parse(line);",
    "      const pending = mcpPending.get(message.id);",
    "      if (!pending) continue;",
    "      mcpPending.delete(message.id);",
    "      if (message.error) pending.reject(new Error(message.error.message || 'mcp_request_failed'));",
    "      else pending.resolvePromise(message.result);",
    "    }",
    "  })();",
    "  await mcpRequest('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-acp', version: '0.0.0' } });",
    "  mcpSend({ jsonrpc: '2.0', method: 'notifications/initialized' });",
    "}",
    "function configText() {",
    "  const home = process.env.HERMES_HOME || '';",
    "  const path = home ? resolve(home, 'config.yaml') : '';",
    "  return path && existsSync(path) ? readFileSync(path, 'utf8') : '';",
    "}",
    "for await (const line of rl) {",
    "  if (!line.trim()) continue;",
    "  const msg = JSON.parse(line);",
    "  if (msg.method === 'initialize') {",
    options.promptImage
      ? "    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'fake-acp', version: '0.0.0' }, agentCapabilities: { promptCapabilities: { image: true } } } });"
      : "    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'fake-acp', version: '0.0.0' }, agentCapabilities: {} } });",
    "  } else if (msg.method === 'session/cancel') {",
    ...(options.notificationRecordPath
      ? [
          `    appendFileSync(${JSON.stringify(options.notificationRecordPath)}, JSON.stringify({ method: msg.method, params: msg.params }) + '\\n');`,
        ]
      : []),
    "  } else if (msg.method === 'session/new') {",
    ...(options.sessionSetupRecordPath
      ? [
          `    appendFileSync(${JSON.stringify(options.sessionSetupRecordPath)}, JSON.stringify({ method: msg.method, params: msg.params }) + '\\n');`,
        ]
      : []),
    ...(options.mcpToolCall ? ["    await startMcp(msg.params.mcpServers?.[0]);"] : []),
    `    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: ${JSON.stringify(sessionId)} } });`,
    "  } else if (msg.method === 'session/load') {",
    ...(options.sessionSetupRecordPath
      ? [
          `    appendFileSync(${JSON.stringify(options.sessionSetupRecordPath)}, JSON.stringify({ method: msg.method, params: msg.params }) + '\\n');`,
        ]
      : []),
    ...(options.mcpToolCall ? ["    await startMcp(msg.params.mcpServers?.[0]);"] : []),
    "    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: msg.params.sessionId } });",
    "  } else if (msg.method === 'session/set_model') {",
    "    send({ jsonrpc: '2.0', id: msg.id, result: {} });",
    "  } else if (msg.method === 'session/prompt') {",
    "    const sessionId = msg.params.sessionId;",
    "    const prompt = msg.params.prompt?.[0]?.text || '';",
    ...(options.mcpToolCall
      ? [
          `    const mcpToolResult = prompt === '/compact' ? undefined : await mcpRequest('tools/call', { name: ${JSON.stringify(options.mcpToolCall.name)}, arguments: ${JSON.stringify(options.mcpToolCall.arguments ?? {})} });`,
          "    const mcpToolText = mcpToolResult?.content?.map((item) => item.text || '').filter(Boolean).join('\\n') || '';",
        ]
      : ["    const mcpToolText = ''; "]),
    ...(options.usageUsed !== undefined && options.usageSize !== undefined
      ? [
          `    if (prompt !== '/compact') send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'usage_update', used: ${Math.floor(options.usageUsed)}, size: ${Math.floor(options.usageSize)} } } });`,
        ]
      : []),
    `    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: ${JSON.stringify(toolTitle)}, kind: 'execute', rawInput: { command: ${JSON.stringify(toolInput)} } } } });`,
    `    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'in_progress', rawOutput: 'running' } } });`,
    `    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'in_progress', rawOutput: 'still running' } } });`,
    `    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed', rawOutput: ${JSON.stringify(toolOutput)} } } });`,
    "    const imageBlock = (msg.params.prompt || []).find((block) => block && block.type === 'image');",
    "    const imageEcho = imageBlock ? `IMAGE:${imageBlock.mimeType}:${imageBlock.data}` : 'IMAGE:none';",
    options.includeConfigEcho
      ? `    const text = [${JSON.stringify(marker)}, \`PROMPT:\${prompt}\`, imageEcho, mcpToolText, \`HERMES_HOME:\${process.env.HERMES_HOME || ''}\`, 'CONFIG_BEGIN', configText(), 'CONFIG_END'].join('\\n');`
      : options.compactUsageUsed !== undefined && options.usageUsed !== undefined
        ? `    const text = prompt === '/compact' ? ['Compaction completed.', '- Messages compacted: 2', '- Tokens before: ${Math.floor(options.usageUsed).toLocaleString("en-US")}', '- Tokens after: ${Math.floor(options.compactUsageUsed).toLocaleString("en-US")}'].join('\\n') : [${JSON.stringify(marker)}, \`PROMPT:\${prompt}\`, imageEcho, mcpToolText].join('\\n');`
        : `    const text = [${JSON.stringify(marker)}, \`PROMPT:\${prompt}\`, imageEcho, mcpToolText].join('\\n');`,
    ...(options.thoughtText
      ? [
          `    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: ${JSON.stringify(options.thoughtText)} } } } });`,
        ]
      : []),
    "    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });",
    "    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } } });",
    "  } else {",
    "    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });",
    "  }",
    "}",
  ].join("\n");
}
