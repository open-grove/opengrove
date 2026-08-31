import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent } from "../core.js";
import { presentAgentEvent } from "../server/event-presentation.js";

test("browser event presentation removes complete model context", () => {
  const event: AgentEvent = {
    type: "model.requested",
    runId: "run-1",
    request: {
      systemPrompt: "secret system prompt".repeat(1_000),
      userInput: "hello",
      messages: [{ role: "user", content: "history".repeat(10_000) }],
      tools: [],
      skills: [],
      packs: [],
      capabilities: [],
    },
  };

  const presented = presentAgentEvent(event);
  assert.equal(presented.type, "model.requested");
  assert.equal(presented.request.systemPrompt, "");
  assert.equal(presented.request.messages, undefined);
  assert.equal(presented.request.userInput, "hello");
});

test("browser event presentation bounds large tool payloads", () => {
  const event: AgentEvent = {
    type: "tool.finished",
    runId: "run-1",
    toolId: "example.tool",
    result: { ok: true, value: { body: "x".repeat(2_000_000) } },
  };

  const serialized = JSON.stringify(presentAgentEvent(event));
  assert.ok(serialized.length < 40_000, `wire event should be bounded, got ${serialized.length}`);
  assert.match(serialized, /…/);
});

test("browser event presentation redacts credential-shaped fields", () => {
  const event: AgentEvent = {
    type: "tool.finished",
    runId: "run-1",
    toolId: "example.tool",
    result: {
      ok: true,
      value: {
        apiKey: "sk-should-not-leak",
        api_secret: "also-should-not-leak",
        nested: {
          authorization: "Bearer should-not-leak",
          bearerToken: "token-should-not-leak",
          credential: "credential-should-not-leak",
          bearer: "bearer-should-not-leak",
          signature: "signature-should-not-leak",
          passwordHash: "hash-should-not-leak",
          tokenCount: 42,
        },
      },
    },
  };

  const serialized = JSON.stringify(presentAgentEvent(event));
  assert.doesNotMatch(serialized, /should-not-leak/);
  assert.match(serialized, /\[redacted\]/);
  assert.match(serialized, /tokenCount/);
});

test("event polling does not replay a complete assistant payload", () => {
  const event: AgentEvent = {
    type: "assistant.final",
    runId: "run-1",
    at: "2026-08-04T00:00:00.000Z",
    text: "x".repeat(2_000_000),
  };

  const presented = presentAgentEvent(event);
  assert.equal(presented.type, "assistant.final");
  assert.ok(presented.text.length <= 8_000);
});

test("event polling omits invoked skill bodies", () => {
  const event: AgentEvent = {
    type: "skill.invoked",
    runId: "run-1",
    skill: {
      id: "skill.large",
      name: "large",
      title: "Large",
      description: "Large skill",
      format: "markdown-v2",
      entry: "SKILL.md",
      skillRoot: "/tmp/large",
      activities: ["chat"],
      toolIds: [],
      memoryHooks: [],
      allowedTools: [],
      userInvocable: true,
      disableModelInvocation: false,
      context: "inline",
      source: "user",
      trust: "trusted",
    },
    invocation: {
      skillId: "skill.large",
      skillName: "large",
      title: "Large",
      content: "x".repeat(2_000_000),
      contentPreview: "preview",
      sourcePath: "/tmp/large/SKILL.md",
      source: "user",
      trust: "trusted",
      context: "inline",
      allowedTools: [],
      invokedAt: "2026-08-04T00:00:00.000Z",
      origin: "user",
    },
  };

  const presented = presentAgentEvent(event);
  assert.equal(presented.type, "skill.invoked");
  assert.equal(presented.invocation.content, "");
  assert.equal(presented.invocation.contentPreview, "preview");
  assert.ok(JSON.stringify(presented).length < 5_000);
});
