import assert from "node:assert/strict";
import { applyClaudeBedrockHelperEnv, applyClaudeHostManagedProviderEnv } from "../runtime/claude-bedrock-env.js";

const explicitAnthropicProviderEnv = applyClaudeBedrockHelperEnv({
  ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
  ANTHROPIC_API_KEY: "ww_sk_test",
  CLAUDE_CODE_USE_BEDROCK: "1",
  ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock-runtime.us-east-1.amazonaws.com",
  AWS_BEARER_TOKEN_BEDROCK: "bedrock-token",
  AWS_REGION: "us-east-1",
});

assert.equal(explicitAnthropicProviderEnv.ANTHROPIC_BASE_URL, "http://127.0.0.1:1");
assert.equal(explicitAnthropicProviderEnv.ANTHROPIC_API_KEY, "ww_sk_test");
assert.equal(explicitAnthropicProviderEnv.CLAUDE_CODE_USE_BEDROCK, undefined);
assert.equal(explicitAnthropicProviderEnv.ANTHROPIC_BEDROCK_BASE_URL, undefined);
assert.equal(explicitAnthropicProviderEnv.AWS_BEARER_TOKEN_BEDROCK, undefined);
assert.equal(explicitAnthropicProviderEnv.AWS_REGION, "us-east-1");

const disabledBedrockEnv = applyClaudeBedrockHelperEnv({
  CLAUDE_CODE_USE_BEDROCK: "0",
  AWS_REGION: "us-east-1",
});

assert.equal(disabledBedrockEnv.CLAUDE_CODE_USE_BEDROCK, "0");
assert.equal(disabledBedrockEnv.ANTHROPIC_BEDROCK_BASE_URL, undefined);

const managedVertexEnv = applyClaudeHostManagedProviderEnv(
  {
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "0",
    CLAUDE_CODE_USE_BEDROCK: "1",
    ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock-runtime.us-east-1.amazonaws.com",
    AWS_BEARER_TOKEN_BEDROCK: "user-bedrock-token",
    ANTHROPIC_BASE_URL: "https://user-provider.example.test",
    ANTHROPIC_AUTH_TOKEN: "user-provider-token",
    ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer user-custom-token",
    ANTHROPIC_UNIX_SOCKET: "/tmp/user-anthropic.sock",
    CLAUDE_CODE_HOST_AUTH_ENV_VAR: "USER_HOST_AUTH_TOKEN",
    USER_HOST_AUTH_TOKEN: "user-host-auth-token",
    CLAUDE_CODE_HOST_CREDS_FILE: "/tmp/user-host-creds.json",
  },
  {
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
    CLAUDE_CODE_USE_VERTEX: "1",
    ANTHROPIC_VERTEX_BASE_URL: "https://us-east5-aiplatform.googleapis.com",
    ANTHROPIC_MODEL: "claude-sonnet-test",
  },
);
const preparedManagedVertexEnv = applyClaudeBedrockHelperEnv(managedVertexEnv);
assert.equal(preparedManagedVertexEnv.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, "1");
assert.equal(preparedManagedVertexEnv.CLAUDE_CODE_USE_VERTEX, "1");
assert.equal(preparedManagedVertexEnv.ANTHROPIC_VERTEX_BASE_URL, "https://us-east5-aiplatform.googleapis.com");
assert.equal(preparedManagedVertexEnv.ANTHROPIC_MODEL, "claude-sonnet-test");
assert.equal(preparedManagedVertexEnv.CLAUDE_CODE_USE_BEDROCK, undefined);
assert.equal(preparedManagedVertexEnv.ANTHROPIC_BEDROCK_BASE_URL, undefined);
assert.equal(preparedManagedVertexEnv.AWS_BEARER_TOKEN_BEDROCK, undefined);
assert.equal(preparedManagedVertexEnv.ANTHROPIC_BASE_URL, undefined);
assert.equal(preparedManagedVertexEnv.ANTHROPIC_AUTH_TOKEN, undefined);
assert.equal(preparedManagedVertexEnv.ANTHROPIC_CUSTOM_HEADERS, undefined);
assert.equal(preparedManagedVertexEnv.ANTHROPIC_UNIX_SOCKET, undefined);
assert.equal(preparedManagedVertexEnv.CLAUDE_CODE_HOST_AUTH_ENV_VAR, undefined);
assert.equal(preparedManagedVertexEnv.USER_HOST_AUTH_TOKEN, undefined);
assert.equal(preparedManagedVertexEnv.CLAUDE_CODE_HOST_CREDS_FILE, undefined);
