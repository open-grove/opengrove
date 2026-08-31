import { chmodSync, writeFileSync } from "node:fs";

export interface FakeHermesGatewayOptions {
  marker?: string;
  sessionId?: string;
  includeConfigEcho?: boolean;
  holdUntilInterrupt?: boolean;
  skipBlockingPrompts?: boolean;
  contextUsedTokens?: number;
  contextMaxTokens?: number;
  compressionError?: string;
  thinkingStatusText?: string;
  reasoningText?: string;
  responseSuffix?: string;
  ambiguousSameNameTools?: boolean;
}

export function writeFakeHermesGateway(path: string, options: FakeHermesGatewayOptions = {}): void {
  writeFileSync(path, fakeHermesGatewaySource(options), "utf8");
  chmodSync(path, 0o755);
}

export function fakeHermesGatewaySource(options: FakeHermesGatewayOptions = {}): string {
  const marker = options.marker ?? "FAKE_HERMES_GATEWAY_OK";
  const sessionId = options.sessionId ?? "fake-hermes-gateway-session";
  const holdUntilInterrupt = Boolean(options.holdUntilInterrupt);
  const skipBlockingPrompts = Boolean(options.skipBlockingPrompts);
  const contextUsedTokens = options.contextUsedTokens ?? 0;
  const contextMaxTokens = options.contextMaxTokens ?? 200_000;
  return [
    "import { createInterface } from 'node:readline';",
    "import { existsSync, readFileSync } from 'node:fs';",
    "import { resolve } from 'node:path';",
    "const rl = createInterface({ input: process.stdin });",
    `const sessionId = ${JSON.stringify(sessionId)};`,
    "const pending = new Map();",
    "const steering = [];",
    "const compressions = [];",
    "function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }",
    "function event(type, session_id, payload) { send({ jsonrpc: '2.0', method: 'event', params: { type, session_id, payload } }); }",
    "function waitFor(key) { return new Promise((resolve) => pending.set(key, resolve)); }",
    "function resolvePending(key, value) { const resolve = pending.get(key); pending.delete(key); resolve?.(value); }",
    "function configText() {",
    "  const home = process.env.HERMES_HOME || '';",
    "  const path = home ? resolve(home, 'config.yaml') : '';",
    "  return path && existsSync(path) ? readFileSync(path, 'utf8') : '';",
    "}",
    "async function runPrompt(text) {",
    holdUntilInterrupt
      ? "  await waitFor('interrupt');"
      : skipBlockingPrompts
        ? ["  const approval = { choice: '' };", "  const answer = { answer: '' };"].join("\n")
        : [
            "  event('approval.request', sessionId, { name: 'terminal', command: 'printf gateway' });",
            "  const approval = await waitFor('approval');",
            "  event('clarify.request', sessionId, { request_id: 'clarify-1', question: 'Which marker?', choices: ['alpha', 'beta'] });",
            "  const answer = await waitFor('clarify');",
          ].join("\n"),
    ...(options.ambiguousSameNameTools
      ? [
          "  event('tool.start', sessionId, { tool_id: 'tool-1', name: 'terminal', context: { command: 'printf first' } });",
          "  event('tool.start', sessionId, { tool_id: 'tool-2', name: 'terminal', context: { command: 'printf second' } });",
          "  event('tool.progress', sessionId, { name: 'terminal', preview: 'ambiguous progress' });",
          "  event('tool.complete', sessionId, { name: 'terminal', summary: 'first result' });",
          "  event('tool.complete', sessionId, { name: 'terminal', summary: 'second result' });",
        ]
      : [
          "  event('tool.start', sessionId, { tool_id: 'tool-1', name: 'terminal', context: { command: 'printf gateway' } });",
          "  event('tool.complete', sessionId, { tool_id: 'tool-1', name: 'terminal', summary: 'printed marker' });",
        ]),
    ...(options.thinkingStatusText
      ? [`  event('thinking.delta', sessionId, { text: ${JSON.stringify(options.thinkingStatusText)} });`]
      : []),
    ...(options.reasoningText
      ? [`  event('reasoning.delta', sessionId, { text: ${JSON.stringify(options.reasoningText)} });`]
      : []),
    holdUntilInterrupt
      ? `  const body = [${JSON.stringify(marker)}, 'INTERRUPTED'].join('\\n');`
      : options.includeConfigEcho
        ? `  const body = [${JSON.stringify(marker)}, \`PROMPT:\${text}\`, \`APPROVAL:\${approval?.choice || ''}\`, \`ANSWER:\${answer?.answer || ''}\`, \`STEER:\${steering.join('|')}\`, \`HERMES_HOME:\${process.env.HERMES_HOME || ''}\`, 'CONFIG_BEGIN', configText(), 'CONFIG_END'].join('\\n');`
        : `  const body = [${JSON.stringify(marker)}, \`PROMPT:\${text}\`, \`APPROVAL:\${approval?.choice || ''}\`, \`ANSWER:\${answer?.answer || ''}\`, \`STEER:\${steering.join('|')}\`].join('\\n');`,
    `  const responseSuffix = ${JSON.stringify(options.responseSuffix ?? "")};`,
    "  const responseText = body + responseSuffix;",
    "  event('message.delta', sessionId, { text: body });",
    "  if (responseSuffix) event('message.delta', sessionId, { text: responseSuffix });",
    holdUntilInterrupt
      ? "  event('message.complete', sessionId, { text: responseText, status: 'interrupted', usage: { input: 7, output: 11, total: 18, cost_usd: 0.001 } });"
      : "  event('message.complete', sessionId, { text: responseText, status: 'complete', usage: { input: 7, output: 11, total: 18, cost_usd: 0.001 } });",
    "}",
    "send({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: { skin: { name: 'fake' } } } });",
    "for await (const line of rl) {",
    "  if (!line.trim()) continue;",
    "  const msg = JSON.parse(line);",
    "  if (msg.method === 'session.create') {",
    `    send({ jsonrpc: '2.0', id: msg.id, result: { session_id: ${JSON.stringify(sessionId)}, info: { model: 'fake-hermes', tools: {}, skills: {}, cwd: process.cwd(), lazy: true } } });`,
    "  } else if (msg.method === 'prompt.submit') {",
    "    send({ jsonrpc: '2.0', id: msg.id, result: { status: 'streaming' } });",
    "    void runPrompt(msg.params?.text || '');",
    "  } else if (msg.method === 'approval.respond') {",
    "    resolvePending('approval', msg.params || {});",
    "    send({ jsonrpc: '2.0', id: msg.id, result: { resolved: true } });",
    "  } else if (msg.method === 'clarify.respond') {",
    "    resolvePending('clarify', msg.params || {});",
    "    send({ jsonrpc: '2.0', id: msg.id, result: { status: 'ok' } });",
    "  } else if (msg.method === 'session.interrupt') {",
    "    resolvePending('interrupt', msg.params || {});",
    "    send({ jsonrpc: '2.0', id: msg.id, result: { status: 'interrupted' } });",
    "  } else if (msg.method === 'session.steer') {",
    "    steering.push(msg.params?.text || '');",
    "    send({ jsonrpc: '2.0', id: msg.id, result: { status: 'accepted' } });",
    "  } else if (msg.method === 'session.compress') {",
    "    compressions.push(msg.params || {});",
    options.compressionError
      ? `    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: ${JSON.stringify(options.compressionError)} } });`
      : "    send({ jsonrpc: '2.0', id: msg.id, result: { status: 'compressed', count: compressions.length } });",
    "  } else if (msg.method === 'session.usage') {",
    `    send({ jsonrpc: '2.0', id: msg.id, result: { context_used: ${contextUsedTokens}, context_max: ${contextMaxTokens}, total: ${contextUsedTokens} } });`,
    "  } else {",
    "    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });",
    "  }",
    "}",
  ].join("\n");
}
