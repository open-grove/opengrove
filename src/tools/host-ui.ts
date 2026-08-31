import type { JsonObject, JsonValue, ToolDefinition, ToolResult, ToolSpec, UserLanguagePreference } from "../core.js";
import { DEFAULT_LOCALE } from "../localization/locale-registry.js";

export interface RequestChoicesContext {
  language?(): UserLanguagePreference | undefined;
}

export function createRequestChoicesTool(
  spec: ToolSpec,
  context: RequestChoicesContext = {},
): ToolDefinition<JsonObject, JsonObject> {
  return {
    spec,
    async execute(input): Promise<ToolResult<JsonObject>> {
      const questions = readChoiceQuestions(input.questions);
      if (!questions.length) {
        return {
          ok: false,
          error: "choice_questions_required",
        };
      }

      const copy = CHOICE_FORM_COPY[context.language?.() ?? DEFAULT_LOCALE];
      return {
        ok: true,
        value: {
          kind: "choice_form",
          formId: readString(input.formId) || `choice_${Date.now().toString(36)}`,
          title: readString(input.title) || copy.title,
          instructions: readString(input.instructions),
          submitLabel: readString(input.submitLabel) || copy.submitLabel,
          questions,
          next: "Compatibility mode: render this form in the host UI. Its submitted choices arrive as the next user turn.",
        },
      };
    },
  };
}

const CHOICE_FORM_COPY = {
  "zh-CN": { title: "请选择", submitLabel: "提交" },
  en: { title: "Choose an option", submitLabel: "Submit" },
} satisfies Record<UserLanguagePreference, { title: string; submitLabel: string }>;

function readChoiceQuestions(value: JsonValue | undefined): JsonObject[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item, index) => {
      const object = record(item);
      const options = readChoiceOptions(object.options);
      const prompt = readString(object.prompt) || readString(object.question);
      if (!prompt || !options.length) {
        return null;
      }
      return {
        id: readString(object.id) || `q${index + 1}`,
        prompt,
        options,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
}

function readChoiceOptions(value: JsonValue | undefined): JsonObject[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item, index) => {
      const object = record(item);
      const label = readString(object.label) || readString(object.text) || readString(object.value);
      if (!label) {
        return null;
      }
      return {
        value: readString(object.value) || String(index + 1),
        label,
        description: readString(object.description),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .slice(0, 8);
}

function record(value: unknown): Record<string, JsonValue | undefined> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, JsonValue | undefined>)
    : {};
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 500) : "";
}
