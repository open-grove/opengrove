import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { resolveCommandPath } from "../../kernel/discovery.js";
import type { BridgeCloudSttProviderSettings, BridgeSttProviderId, BridgeVoiceSettings } from "../bridge-types.js";
import { normalizeSttProviderId, resolveCloudApiKey } from "./settings.js";

const MAX_AUDIO_BYTES = 25_000_000;
const TRANSCRIPTION_TIMEOUT_MS = 5 * 60_000;

export interface VoiceTranscriptionRequest {
  audioBase64: string;
  mimeType?: string;
  filename?: string;
  language?: string;
  provider?: BridgeSttProviderId;
}

export interface VoiceTranscriptionResult {
  ok: true;
  transcript: string;
  language?: string;
  durationMs: number;
  provider: BridgeSttProviderId;
  model?: string;
}

export async function transcribeVoiceAudio(
  settings: BridgeVoiceSettings,
  request: VoiceTranscriptionRequest,
): Promise<VoiceTranscriptionResult> {
  const startedAt = Date.now();
  const provider = normalizeSttProviderId(request.provider, settings.stt.provider);
  const language = normalizeLanguage(request.language || settings.stt.language);
  const audio = decodeAudio(request.audioBase64);
  const mimeType = normalizeMimeType(request.mimeType);
  const filename = request.filename?.trim() || `opengrove-voice${extensionForMimeType(mimeType)}`;

  if (provider === "browser") {
    throw new Error("browser_stt_runs_in_client");
  }
  if (provider === "openai") {
    const result = await transcribeOpenAiCompatible({
      provider,
      settings: settings.stt.openai,
      fallbackApiKeyEnv: "OPENAI_API_KEY",
      audio,
      mimeType,
      filename,
      language,
    });
    return {
      ...result,
      durationMs: Date.now() - startedAt,
    };
  }
  if (provider === "groq") {
    const result = await transcribeOpenAiCompatible({
      provider,
      settings: settings.stt.groq,
      fallbackApiKeyEnv: "GROQ_API_KEY",
      audio,
      mimeType,
      filename,
      language,
    });
    return {
      ...result,
      durationMs: Date.now() - startedAt,
    };
  }

  const result = await transcribeLocalWhisper({
    command: settings.stt.localWhisper.command,
    model: settings.stt.localWhisper.model,
    language: normalizeLanguage(language || settings.stt.localWhisper.language),
    audio,
    mimeType,
    filename,
  });
  return {
    ok: true,
    transcript: result.transcript,
    language,
    durationMs: Date.now() - startedAt,
    provider,
    model: settings.stt.localWhisper.model,
  };
}

async function transcribeOpenAiCompatible(options: {
  provider: "openai" | "groq";
  settings: BridgeCloudSttProviderSettings;
  fallbackApiKeyEnv: string;
  audio: Buffer;
  mimeType: string;
  filename: string;
  language?: string;
}): Promise<Omit<VoiceTranscriptionResult, "durationMs">> {
  const apiKey = resolveCloudApiKey(options.settings, options.fallbackApiKeyEnv);
  if (!apiKey) {
    throw new Error(`${options.provider}_stt_api_key_missing`);
  }

  const body = new FormData();
  body.append("file", new Blob([new Uint8Array(options.audio)], { type: options.mimeType }), options.filename);
  body.append("model", options.settings.model);
  if (options.language) {
    body.append("language", options.language);
  }

  const response = await fetch(`${trimTrailingSlash(options.settings.baseUrl)}/audio/transcriptions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
    },
    body,
  });
  if (!response.ok) {
    throw new Error(`${options.provider}_stt_request_failed:${response.status}:${await response.text()}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  const transcript = stringValue(data.text) || stringValue(data.transcript);
  if (!transcript) {
    throw new Error(`${options.provider}_stt_empty_transcript`);
  }

  return {
    ok: true,
    transcript,
    language: stringValue(data.language) || options.language,
    provider: options.provider,
    model: options.settings.model,
  };
}

async function transcribeLocalWhisper(options: {
  command?: string;
  model: string;
  language?: string;
  audio: Buffer;
  mimeType: string;
  filename: string;
}): Promise<{ transcript: string }> {
  const tempDir = await mkdtemp(join(tmpdir(), "opengrove-stt-"));
  const inputPath = join(tempDir, safeAudioFilename(options.filename, options.mimeType));
  const outputPath = join(tempDir, "transcript.txt");
  try {
    await writeFile(inputPath, options.audio);
    const command = options.command?.trim();
    if (command) {
      const result = await runShell(
        localCommandTemplate(command, {
          inputPath,
          outputPath,
          outputDir: tempDir,
          model: options.model,
          language: options.language,
        }),
        tempDir,
      );
      const transcript = await readTranscriptOutput(tempDir, outputPath, result.stdout);
      return { transcript };
    }

    const whisper = resolveCommandPath("whisper");
    if (!whisper) {
      throw new Error("local_whisper_not_configured");
    }
    const args = [inputPath, "--model", options.model || "base", "--output_format", "txt", "--output_dir", tempDir];
    if (options.language) {
      args.push("--language", options.language);
    }
    const result = await runProcess(whisper, args, tempDir);
    const transcript = await readTranscriptOutput(tempDir, outputPath, result.stdout);
    return { transcript };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function readTranscriptOutput(tempDir: string, preferredPath: string, stdout: string): Promise<string> {
  const preferred = await readOptionalText(preferredPath);
  if (preferred.trim()) return preferred.trim();
  const entries = await readdir(tempDir);
  for (const entry of entries) {
    if (entry.endsWith(".txt")) {
      const text = await readOptionalText(join(tempDir, entry));
      if (text.trim()) return text.trim();
    }
  }
  if (stdout.trim()) return stdout.trim();
  throw new Error("local_whisper_empty_transcript");
}

async function readOptionalText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function localCommandTemplate(
  template: string,
  values: {
    inputPath: string;
    outputPath: string;
    outputDir: string;
    model: string;
    language?: string;
  },
): string {
  const replacements: Record<string, string> = {
    input: shellQuote(values.inputPath),
    output: shellQuote(values.outputPath),
    outputDir: shellQuote(values.outputDir),
    model: shellQuote(values.model),
    language: shellQuote(values.language || ""),
  };
  let command = template;
  for (const [key, value] of Object.entries(replacements)) {
    command = command.replaceAll(`{${key}}`, value);
  }
  return command.includes("{input}") || template.includes("{input}")
    ? command
    : `${command} ${shellQuote(values.inputPath)}`;
}

function runProcess(command: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    resolveChildProcess(child, resolve, reject);
  });
}

function runShell(command: string, cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    resolveChildProcess(child, resolve, reject);
  });
}

function resolveChildProcess(
  child: ReturnType<typeof spawn>,
  resolve: (value: { stdout: string; stderr: string }) => void,
  reject: (reason?: unknown) => void,
): void {
  let stdout = "";
  let stderr = "";
  const timeout = setTimeout(() => {
    child.kill("SIGTERM");
    reject(new Error("local_whisper_timeout"));
  }, TRANSCRIPTION_TIMEOUT_MS);
  child.stdout?.on("data", (chunk) => {
    stdout += Buffer.from(chunk).toString("utf8");
  });
  child.stderr?.on("data", (chunk) => {
    stderr += Buffer.from(chunk).toString("utf8");
  });
  child.on("error", (error) => {
    clearTimeout(timeout);
    reject(error);
  });
  child.on("close", (code) => {
    clearTimeout(timeout);
    if (code === 0) {
      resolve({ stdout, stderr });
      return;
    }
    reject(new Error(`local_whisper_failed:${code}:${stderr.trim() || stdout.trim()}`));
  });
}

function decodeAudio(audioBase64: string): Buffer {
  const raw = audioBase64.replace(/^data:[^;]+;base64,/, "").trim();
  if (!raw) {
    throw new Error("audio_required");
  }
  const buffer = Buffer.from(raw, "base64");
  if (!buffer.byteLength) {
    throw new Error("audio_required");
  }
  if (buffer.byteLength > MAX_AUDIO_BYTES) {
    throw new Error("audio_too_large");
  }
  return buffer;
}

function safeAudioFilename(filename: string, mimeType: string): string {
  const safeBase = basename(filename).replace(/[^a-zA-Z0-9._-]+/g, "-") || "audio";
  return safeBase.includes(".") ? safeBase : `${safeBase}${extensionForMimeType(mimeType)}`;
}

function normalizeMimeType(value: string | undefined): string {
  const trimmed = value?.split(";")[0]?.trim().toLowerCase();
  return trimmed || "audio/webm";
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType.includes("mp4")) return ".mp4";
  if (mimeType.includes("mpeg")) return ".mp3";
  if (mimeType.includes("wav")) return ".wav";
  if (mimeType.includes("ogg")) return ".ogg";
  if (mimeType.includes("webm")) return ".webm";
  return ".audio";
}

function normalizeLanguage(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed !== "auto" ? trimmed : undefined;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/g, "");
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
