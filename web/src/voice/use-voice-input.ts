import { useEffect, useRef, useState } from "react";
import { transcribeVoiceAudio, type VoiceSettings } from "../bridge";

export type VoiceCaptureState = "idle" | "recording" | "transcribing";

export interface VoiceInputCopy {
  browserUnavailable: string;
  mediaUnavailable: string;
  transcriptionFailed(message: string): string;
  recordingFailed(message: string): string;
}

export function useVoiceInput(options: {
  voiceSettings?: VoiceSettings;
  copy: VoiceInputCopy;
  onTranscript(transcript: string): void;
  onSystemMessage(message: string): void;
}) {
  const [state, setState] = useState<VoiceCaptureState>("idle");
  const [error, setError] = useState("");
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaRecorderStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderChunksRef = useRef<BlobPart[]>([]);
  const speechRecognitionRef = useRef<SpeechRecognitionLike | null>(null);

  useEffect(
    () => () => {
      speechRecognitionRef.current?.abort();
      mediaRecorderStreamRef.current?.getTracks().forEach((track) => track.stop());
    },
    [],
  );

  function stop() {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      setState("transcribing");
      mediaRecorderRef.current.stop();
      return;
    }
    if (speechRecognitionRef.current) {
      setState("transcribing");
      speechRecognitionRef.current.stop();
    }
  }

  async function toggle() {
    if (state === "recording") {
      stop();
      return;
    }
    if (state === "transcribing") {
      return;
    }

    const provider = options.voiceSettings?.stt.provider ?? "openai";
    const language = options.voiceSettings?.stt.language ?? "auto";
    setError("");

    if (provider === "browser") {
      startBrowserSpeechInput(language);
      return;
    }
    await startRecordedSpeechInput(provider, language);
  }

  function startBrowserSpeechInput(language: string) {
    const Recognition = speechRecognitionConstructor();
    if (!Recognition) {
      const message = "browser_stt_unavailable";
      setError(message);
      options.onSystemMessage(options.copy.browserUnavailable);
      return;
    }

    const recognition = new Recognition();
    let latestTranscript = "";
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = voiceLanguage(language);
    recognition.onresult = (event) => {
      let nextTranscript = latestTranscript;
      const startIndex = event.resultIndex ?? 0;
      for (let index = startIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result?.[0]?.transcript?.trim();
        if (transcript) {
          nextTranscript = result?.isFinal ? `${nextTranscript} ${transcript}`.trim() : transcript;
        }
      }
      latestTranscript = nextTranscript;
    };
    recognition.onerror = (event) => {
      const message = event.error || event.message || "browser_stt_failed";
      speechRecognitionRef.current = null;
      setState("idle");
      setError(message);
      options.onSystemMessage(options.copy.transcriptionFailed(message));
    };
    recognition.onend = () => {
      speechRecognitionRef.current = null;
      setState("idle");
      options.onTranscript(latestTranscript);
    };
    speechRecognitionRef.current = recognition;
    setState("recording");
    try {
      recognition.start();
    } catch (startError) {
      speechRecognitionRef.current = null;
      setState("idle");
      const message = startError instanceof Error ? startError.message : String(startError);
      setError(message);
      options.onSystemMessage(options.copy.transcriptionFailed(message));
    }
  }

  async function startRecordedSpeechInput(provider: "openai" | "groq" | "local-whisper", language: string) {
    // runtime-boundary: older embedded browsers can omit mediaDevices despite the lib.dom declaration.
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      const message = "media_recorder_unavailable";
      setError(message);
      options.onSystemMessage(options.copy.mediaUnavailable);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      mediaRecorderChunksRef.current = [];
      mediaRecorderStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          mediaRecorderChunksRef.current.push(event.data);
        }
      };
      recorder.onstop = () => {
        void finishRecordedSpeechInput(provider, language, recorder.mimeType || "audio/webm");
      };
      recorder.start();
      setState("recording");
    } catch (recordingError) {
      const message = recordingError instanceof Error ? recordingError.message : String(recordingError);
      setError(message);
      setState("idle");
      options.onSystemMessage(options.copy.recordingFailed(message));
    }
  }

  async function finishRecordedSpeechInput(
    provider: "openai" | "groq" | "local-whisper",
    language: string,
    mimeType: string,
  ) {
    const chunks = mediaRecorderChunksRef.current;
    mediaRecorderChunksRef.current = [];
    mediaRecorderRef.current = null;
    mediaRecorderStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaRecorderStreamRef.current = null;

    try {
      if (!chunks.length) {
        throw new Error("audio_required");
      }
      const blob = new Blob(chunks, { type: mimeType });
      const result = await transcribeVoiceAudio({
        audioBase64: await blobToBase64(blob),
        mimeType: blob.type || mimeType,
        provider,
        language,
      });
      if (!result.ok || !result.transcript) {
        throw new Error(result.error || "empty_transcript");
      }
      options.onTranscript(result.transcript);
    } catch (transcriptionError) {
      const message = transcriptionError instanceof Error ? transcriptionError.message : String(transcriptionError);
      setError(message);
      options.onSystemMessage(options.copy.transcriptionFailed(message));
    } finally {
      setState("idle");
    }
  }

  return {
    state,
    error,
    toggle,
    stop,
  };
}

type SpeechRecognitionAlternativeLike = {
  transcript?: string;
};

type SpeechRecognitionResultLike = {
  isFinal?: boolean;
  [index: number]: SpeechRecognitionAlternativeLike | undefined;
};

type SpeechRecognitionEventLike = {
  resultIndex?: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
};

type SpeechRecognitionErrorLike = {
  error?: string;
  message?: string;
};

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorLike) => void) | null;
  onend: (() => void) | null;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function speechRecognitionConstructor(): SpeechRecognitionConstructor | undefined {
  const speechWindow = window as typeof window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
}

function voiceLanguage(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed && trimmed !== "auto" ? trimmed : "";
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result.includes(",") ? result.split(",").pop() || "" : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("read_audio_failed"));
    reader.readAsDataURL(blob);
  });
}
