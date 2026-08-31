import type { JsonObject } from "../core.js";
import {
  isoTimestamp,
  type EnvironmentActionRequest,
  type EnvironmentAdapter,
  type EnvironmentObservation,
} from "./adapter.js";

export interface BrowserPageSnapshot {
  url?: string;
  title?: string;
  selection?: string;
  visibleText?: string;
  locator?: string;
  attachments?: BrowserPageAttachmentSnapshot[];
}

export interface BrowserPageAttachmentSnapshot {
  id?: string;
  name: string;
  kind: "image" | "text" | "file";
  mimeType?: string;
  size?: number;
  text?: string;
  dataUrl?: string;
  localPath?: string;
}

export type BrowserPageReader = () => BrowserPageSnapshot | Promise<BrowserPageSnapshot>;

export interface BrowserEnvironmentObservation extends EnvironmentObservation {
  kind: "browser";
  data: JsonObject;
}

export interface BrowserEnvironmentAdapter extends EnvironmentAdapter<BrowserEnvironmentObservation> {
  kind: "browser";
}

export function createReadOnlyBrowserAdapter(readPage: BrowserPageReader): BrowserEnvironmentAdapter {
  return {
    kind: "browser",
    async observe() {
      return browserPageToObservation(await readPage());
    },
    async requestAction(request: EnvironmentActionRequest) {
      return {
        status: "staged",
        message: "No remote page mutation was executed by this V0 browser adapter.",
        data: {
          instruction: request.action,
          target: request.target ?? "",
          rationale: request.rationale ?? "",
          nextIntegrationPoint: "Stagehand observe/act/cache adapter",
        },
      };
    },
    canExecute() {
      return false;
    },
  };
}

export function browserPageToObservation(page: BrowserPageSnapshot): BrowserEnvironmentObservation {
  const title = page.title ?? "";
  const url = page.url ?? "";
  const locator = page.locator ?? "";
  const selection = page.selection ?? "";

  return {
    kind: "browser",
    observedAt: isoTimestamp(),
    summary: title || url || locator || "browser page",
    data: {
      title,
      url,
      selection,
      locator,
      visibleText: truncate(page.visibleText ?? "", 1800),
      note: "This is the safe read-only boundary for a future Stagehand observe/extract wrapper.",
    },
  };
}

export function buildBrowserActionRequest(input: JsonObject): EnvironmentActionRequest {
  const instruction = readRequiredString(input, "instruction");
  return {
    kind: "browser",
    action: instruction,
    target: readString(input, "target"),
    rationale: readString(input, "rationale"),
    data: {
      instruction,
    },
  };
}

function readRequiredString(input: JsonObject, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Expected non-empty string input: ${key}`);
  }
  return value.trim();
}

function readString(input: JsonObject, key: string): string {
  const value = input[key];
  return typeof value === "string" ? value.trim() : "";
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}
