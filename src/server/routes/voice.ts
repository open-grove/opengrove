import type { IncomingMessage, ServerResponse } from "node:http";
import type { BridgeState } from "../bridge-types.js";
import type { BridgeSecurity } from "../bridge-security.js";
import { getBridgeSttProviderCatalog } from "../voice/settings.js";
import { transcribeVoiceAudio, type VoiceTranscriptionRequest } from "../voice/transcription.js";

type SendJson = (response: ServerResponse, status: number, data: unknown) => void;
type ReadJsonBody = (request: IncomingMessage) => Promise<unknown>;

export async function handleVoiceRoute(options: {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  state: BridgeState;
  security?: BridgeSecurity;
  sendJson: SendJson;
  readJsonBody: ReadJsonBody;
}): Promise<boolean> {
  const { request, response, url, state, sendJson, readJsonBody } = options;
  if (request.method === "GET" && url.pathname === "/voice/stt/providers") {
    sendJson(response, 200, {
      ok: true,
      provider: state.settings.voice.stt.provider,
      providers: getBridgeSttProviderCatalog(state.settings.voice),
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/voice/transcriptions") {
    try {
      const result = await transcribeVoiceAudio(
        state.settings.voice,
        normalizeVoiceTranscriptionPayload(await readJsonBody(request)),
      );
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  return false;
}

function normalizeVoiceTranscriptionPayload(input: unknown): VoiceTranscriptionRequest {
  const source = record(input);
  return {
    audioBase64: stringValue(source.audioBase64) || stringValue(source.audio),
    mimeType: stringValue(source.mimeType) || stringValue(source.contentType),
    filename: stringValue(source.filename) || undefined,
    language: stringValue(source.language) || undefined,
    provider: stringValue(source.provider) as VoiceTranscriptionRequest["provider"],
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
