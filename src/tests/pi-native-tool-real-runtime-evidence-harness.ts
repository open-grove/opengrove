import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CERTIFIED_KERNEL_CONTRACT_TESTS } from "../kernel/capabilities/contract-test-evidence.js";
import type { KernelRealRuntimeEvidenceFile } from "../kernel/capabilities/real-runtime-evidence.js";

const MODEL_ID = "opengrove-pi-native-tool-evidence";
const API_KEY = "local-protocol-fixture";

async function main(): Promise<void> {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "opengrove-pi-native-tool-evidence-"));
  const evidencePath = join(fixtureRoot, "pi-native-tool.json");
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    void handleCompletion(request, response, requests).catch((error: unknown) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;

  try {
    const output = await runProbe({
      evidencePath,
      probeCwd: join(fixtureRoot, "workspace"),
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
    });
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as KernelRealRuntimeEvidenceFile;
    const probe = evidence.probes.find((item) => item.kernel === "pi" && item.capability === "tools.nativeTool");
    const contractTest = evidence.contractTests.find(
      (item) => item.kernel === "pi" && item.capability === "tools.nativeTool",
    );
    const published = CERTIFIED_KERNEL_CONTRACT_TESTS.filter(
      (item) => item.kernel === "pi" && item.capability === "tools.nativeTool",
    );

    assert.equal(probe?.status, "passed", output);
    assert.equal(probe?.events?.nativeToolStarted, true);
    assert.equal(probe?.events?.nativeToolFinished, true);
    assert.equal(contractTest?.testId, "pi.tools.nativeTool");
    assert.equal(contractTest?.verification, "real_runtime");
    assert.equal(contractTest?.passed, true);
    assert.equal(published.length, 1, "the certified ledger must have one Pi native-tool row");
    assert.deepEqual(
      stableContractTest(published[0]),
      stableContractTest(contractTest ? publishedContractTest(contractTest) : undefined),
      "the imported certification row must match the stable facts from the freshly executed official AgentHarness slice",
    );
    assert.equal(requests.length, 2, "the Pi loop must resume after native Bash completes");
    assert.ok(Array.isArray(requests[0]?.tools), "the Provider request must expose Pi native tools");
    assert.ok(JSON.stringify(requests[1]?.messages ?? []).includes("tool"));
    console.log("pi native-tool real-runtime evidence harness: all assertions passed ✓");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function publishedContractTest(
  contractTest: KernelRealRuntimeEvidenceFile["contractTests"][number],
): KernelRealRuntimeEvidenceFile["contractTests"][number] {
  const { source: _source, sourcePath: _sourcePath, ...published } = contractTest;
  return published;
}

function stableContractTest(
  contractTest: KernelRealRuntimeEvidenceFile["contractTests"][number] | undefined,
): Omit<KernelRealRuntimeEvidenceFile["contractTests"][number], "checkedAt"> | undefined {
  if (!contractTest) return undefined;
  const { checkedAt: _checkedAt, ...stable } = contractTest;
  return stable;
}

async function handleCompletion(
  request: IncomingMessage,
  response: ServerResponse,
  requests: Array<Record<string, unknown>>,
): Promise<void> {
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/v1/chat/completions");
  assert.equal(request.headers.authorization, `Bearer ${API_KEY}`);
  const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
  requests.push(body);
  const serializedMessages = JSON.stringify(Array.isArray(body.messages) ? body.messages : []);
  const marker = serializedMessages.match(/OG_REAL_RUNTIME_[A-Z0-9_]+/)?.[0];
  assert.ok(marker);

  response.writeHead(200, { "cache-control": "no-cache", "content-type": "text/event-stream" });
  if (!serializedMessages.includes('"role":"tool"')) {
    writeChunk(response, {
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "pi-native-evidence-bash",
                type: "function",
                function: { name: "bash", arguments: JSON.stringify({ command: "pwd" }) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    writeChunk(response, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
  } else {
    writeChunk(response, {
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: `Native Bash completed for ${marker}.` },
          finish_reason: null,
        },
      ],
    });
    writeChunk(response, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  }
  response.end("data: [DONE]\n\n");
}

function writeChunk(response: ServerResponse, value: Record<string, unknown>): void {
  response.write(
    `data: ${JSON.stringify({
      id: "pi-native-tool-evidence",
      object: "chat.completion.chunk",
      created: 1,
      model: MODEL_ID,
      ...value,
    })}\n\n`,
  );
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function runProbe(input: { evidencePath: string; probeCwd: string; baseUrl: string }): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "dist/tests/kernel-capability-real-runtime-probe-runner.js",
        "--kernels",
        "pi",
        "--capabilities",
        "tools.nativeTool",
        "--out",
        input.evidencePath,
        "--cwd",
        input.probeCwd,
        "--timeout-ms",
        "30000",
        "--openai-base-url",
        input.baseUrl,
        "--model",
        MODEL_ID,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          OPENGROVE_REAL_RUNTIME_OPENAI_API_KEY: API_KEY,
          OPENAI_API_KEY: undefined,
          MODEL_API_KEY: undefined,
          ANTHROPIC_API_KEY: undefined,
          ANTHROPIC_AUTH_TOKEN: undefined,
          GEMINI_API_KEY: undefined,
          GOOGLE_API_KEY: undefined,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(output);
      else reject(new Error(`probe runner failed (code=${code}, signal=${signal ?? "none"})\n${output}`));
    });
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
