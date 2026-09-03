import { bridgeContractIssues, type BridgeContractIssue, type HostOperation } from "#protocol";
import type { CompiledHostInputSection, CompiledHostOperation } from "#protocol/compiler";

export const DEFAULT_HOST_OPERATION_BRIDGE_API_URL = "http://127.0.0.1:37371/api";

const COMMON_OPTION_FLAGS = new Set(["input", "base-url", "token", "format", "dry-run", "yes", "help"]);

export type HostOperationCliField = Readonly<{
  name: string;
  flag: string;
  required: boolean;
  schema: Readonly<Record<string, unknown>>;
}>;

export type HostOperationParsedOptions = Readonly<{
  baseUrl: string;
  baseUrlSource: "flag" | "environment" | "default";
  token?: string;
  dryRun: boolean;
  yes: boolean;
  flatInput: Readonly<Record<string, unknown>>;
}>;

export type HostOperationDecodedCall = Readonly<{
  params?: unknown;
  query?: unknown;
  body?: unknown;
}>;

export class HostOperationCliUsageError extends Error {
  readonly code: string;
  readonly issues?: readonly BridgeContractIssue[];

  constructor(code: string, message: string, issues?: readonly BridgeContractIssue[]) {
    super(message);
    this.name = "HostOperationCliUsageError";
    this.code = code;
    this.issues = issues;
  }
}

export function assertHostOperationInputCatalog(operations: readonly CompiledHostOperation[]): void {
  for (const operation of operations) hostOperationFields(operation);
}

export function hostOperationFields(operation: CompiledHostOperation): HostOperationCliField[] {
  const fields = (["params", "query", "body"] as const).flatMap((sectionName) => {
    const section = operation.input[sectionName];
    return section ? sectionFields(section) : [];
  });
  const byFlag = new Map<string, string>();
  for (const field of fields) {
    if (COMMON_OPTION_FLAGS.has(field.flag)) {
      throw new Error(
        `Host operation ${operation.id} field ${field.name} conflicts with common option --${field.flag}.`,
      );
    }
    const previous = byFlag.get(field.flag);
    if (previous) {
      throw new Error(`Host operation ${operation.id} fields ${previous} and ${field.name} map to --${field.flag}.`);
    }
    byFlag.set(field.flag, field.name);
  }
  return fields;
}

export function parseHostOperationOptions(
  operation: CompiledHostOperation,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): HostOperationParsedOptions {
  const fields = hostOperationFields(operation);
  const fieldsByFlag = new Map(fields.map((field) => [field.flag, field]));
  const assignedFields = new Map<string, unknown[]>();
  let input: Record<string, unknown> = {};
  let inputSeen = false;
  let baseUrl = env.OPENGROVE_BRIDGE_URL?.trim() || DEFAULT_HOST_OPERATION_BRIDGE_API_URL;
  let baseUrlSource: HostOperationParsedOptions["baseUrlSource"] = env.OPENGROVE_BRIDGE_URL?.trim()
    ? "environment"
    : "default";
  let token = env.OPENGROVE_BRIDGE_TOKEN?.trim() || undefined;
  let dryRun = false;
  let yes = false;

  for (let index = 0; index < args.length; index += 1) {
    const rawArg = args[index]!;
    if (!rawArg.startsWith("-")) {
      throw new HostOperationCliUsageError("unexpected_argument", `Unexpected argument: ${rawArg}`);
    }
    const { flag, inlineValue } = splitFlag(rawArg);
    if (flag === "--dry-run") {
      assertNoInlineValue(flag, inlineValue);
      dryRun = true;
      continue;
    }
    if (flag === "--yes") {
      assertNoInlineValue(flag, inlineValue);
      yes = true;
      continue;
    }
    if (flag === "--input") {
      if (inputSeen) throw new HostOperationCliUsageError("duplicate_option", "--input may only be provided once.");
      const value = readOptionValue(args, index, flag, inlineValue);
      index += inlineValue === undefined ? 1 : 0;
      input = parseJsonObject(value, flag);
      inputSeen = true;
      continue;
    }
    if (flag === "--base-url") {
      const value = readOptionValue(args, index, flag, inlineValue);
      index += inlineValue === undefined ? 1 : 0;
      baseUrl = value;
      baseUrlSource = "flag";
      continue;
    }
    if (flag === "--token") {
      const value = readOptionValue(args, index, flag, inlineValue);
      index += inlineValue === undefined ? 1 : 0;
      token = value;
      continue;
    }
    if (flag === "--format") {
      const value = readOptionValue(args, index, flag, inlineValue);
      index += inlineValue === undefined ? 1 : 0;
      if (value !== "json") {
        throw new HostOperationCliUsageError("unsupported_format", `Unsupported output format: ${value}. Use json.`);
      }
      continue;
    }
    const directField = fieldsByFlag.get(flag.slice(2));
    const negativeName = !directField && flag.startsWith("--no-") ? flag.slice("--no-".length) : undefined;
    const field = directField ?? (negativeName ? fieldsByFlag.get(negativeName) : undefined);
    if (!field) {
      throw new HostOperationCliUsageError("unknown_option", `Unknown option for ${operation.id}: ${flag}`);
    }
    const isBoolean = schemaType(field.schema) === "boolean";
    if (negativeName) {
      if (!isBoolean) {
        throw new HostOperationCliUsageError("invalid_option", `${flag} is only valid for a boolean field.`);
      }
      assertNoInlineValue(flag, inlineValue);
      appendAssignedField(assignedFields, field, false);
      continue;
    }
    if (isBoolean && inlineValue === undefined && (args[index + 1]?.startsWith("-") ?? true)) {
      appendAssignedField(assignedFields, field, true);
      continue;
    }
    const value = readOptionValue(args, index, flag, inlineValue);
    index += inlineValue === undefined ? 1 : 0;
    appendAssignedField(assignedFields, field, parseFieldValue(field, value));
  }

  const allowedFields = new Set(fields.map((field) => field.name));
  const unknownInputFields = Object.keys(input).filter((name) => !allowedFields.has(name));
  if (unknownInputFields.length > 0) {
    throw new HostOperationCliUsageError(
      "unknown_input_field",
      `Unknown --input field: ${unknownInputFields.join(", ")}`,
    );
  }
  for (const field of fields) {
    const assigned = assignedFields.get(field.name);
    if (!assigned) continue;
    input[field.name] = schemaType(field.schema) === "array" ? assigned.flatMap(arrayValue) : assigned.at(-1);
  }

  return {
    baseUrl: validateBaseUrl(baseUrl),
    baseUrlSource,
    ...(token ? { token } : {}),
    dryRun,
    yes,
    flatInput: input,
  };
}

export function decodeHostOperationCall(
  operation: HostOperation,
  compiled: CompiledHostOperation,
  flatInput: Readonly<Record<string, unknown>>,
): HostOperationDecodedCall {
  const call: { params?: unknown; query?: unknown; body?: unknown } = {};
  for (const name of ["params", "query", "body"] as const) {
    const section = compiled.input[name];
    const schema = operation[name];
    if (!section || !schema) continue;
    const raw = Object.fromEntries(
      section.fields.flatMap((field) =>
        Object.hasOwn(flatInput, field.name) ? [[field.name, flatInput[field.name]]] : [],
      ),
    );
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const issues = bridgeContractIssues(parsed.error).map((issue) => ({
        ...issue,
        path: issue.path === "$" ? name : `${name}.${issue.path}`,
      }));
      throw new HostOperationCliUsageError("input_invalid", `Input does not satisfy ${operation.id}.`, issues);
    }
    call[name] = parsed.data;
  }
  return call;
}

export function hostOperationSchemaValueLabel(schema: Readonly<Record<string, unknown>>): string {
  const type = schemaType(schema);
  if (type !== "array") return type ?? "json";
  const arraySchema = nonNullSchema(schema);
  const items = isRecord(arraySchema.items) ? arraySchema.items : {};
  return `${schemaType(items) ?? "json"}...`;
}

function sectionFields(section: CompiledHostInputSection): HostOperationCliField[] {
  const properties = isRecord(section.jsonSchema.properties) ? section.jsonSchema.properties : {};
  return section.fields.map((field) => {
    const propertySchema = properties[field.name];
    return {
      name: field.name,
      flag: kebabCase(field.name),
      required: field.required,
      schema: isRecord(propertySchema) ? propertySchema : {},
    };
  });
}

function splitFlag(arg: string): { flag: string; inlineValue?: string } {
  if (!arg.startsWith("--")) throw new HostOperationCliUsageError("unknown_option", `Unknown option: ${arg}`);
  const equals = arg.indexOf("=");
  return equals === -1 ? { flag: arg } : { flag: arg.slice(0, equals), inlineValue: arg.slice(equals + 1) };
}

function readOptionValue(args: readonly string[], index: number, flag: string, inlineValue?: string): string {
  if (inlineValue !== undefined) {
    if (!inlineValue) throw new HostOperationCliUsageError("option_value_required", `${flag} requires a value.`);
    return inlineValue;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new HostOperationCliUsageError("option_value_required", `${flag} requires a value.`);
  }
  return value;
}

function assertNoInlineValue(flag: string, inlineValue?: string): void {
  if (inlineValue !== undefined) {
    throw new HostOperationCliUsageError("unexpected_option_value", `${flag} does not accept a value.`);
  }
}

function appendAssignedField(assigned: Map<string, unknown[]>, field: HostOperationCliField, value: unknown): void {
  const values = assigned.get(field.name) ?? [];
  if (schemaType(field.schema) !== "array" && values.length > 0) {
    throw new HostOperationCliUsageError("duplicate_option", `--${field.flag} may only be provided once.`);
  }
  values.push(value);
  assigned.set(field.name, values);
}

function parseFieldValue(field: HostOperationCliField, value: string): unknown {
  switch (schemaType(field.schema)) {
    case "array": {
      if (looksLikeJsonArray(value)) {
        const parsed = parseJson(value, `--${field.flag}`);
        if (!Array.isArray(parsed)) {
          throw new HostOperationCliUsageError("invalid_option_value", `--${field.flag} requires an array.`);
        }
        return parsed;
      }
      const arraySchema = nonNullSchema(field.schema);
      const items = isRecord(arraySchema.items) ? arraySchema.items : {};
      return parseScalarValue(items, value, `--${field.flag}`);
    }
    case "object": {
      const parsed = parseJson(value, `--${field.flag}`);
      if (!isRecord(parsed)) {
        throw new HostOperationCliUsageError("invalid_option_value", `--${field.flag} requires a JSON object.`);
      }
      return parsed;
    }
    default:
      return parseScalarValue(field.schema, value, `--${field.flag}`);
  }
}

function parseScalarValue(schema: Readonly<Record<string, unknown>>, value: string, owner: string): unknown {
  switch (schemaType(schema)) {
    case "integer": {
      const parsed = Number(value);
      if (!Number.isInteger(parsed)) {
        throw new HostOperationCliUsageError("invalid_option_value", `${owner} requires an integer.`);
      }
      return parsed;
    }
    case "number": {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        throw new HostOperationCliUsageError("invalid_option_value", `${owner} requires a number.`);
      }
      return parsed;
    }
    case "boolean":
      if (value === "true") return true;
      if (value === "false") return false;
      throw new HostOperationCliUsageError("invalid_option_value", `${owner} requires true or false.`);
    case "null":
      if (value === "null") return null;
      throw new HostOperationCliUsageError("invalid_option_value", `${owner} requires null.`);
    case "object":
    case "array":
      return parseJson(value, owner);
    case "string":
      return value;
    default:
      return looksLikeJson(value) ? parseJson(value, owner) : value;
  }
}

function validateBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HostOperationCliUsageError("invalid_base_url", `Invalid Bridge API base URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HostOperationCliUsageError("invalid_base_url", `Bridge API base URL must use http or https: ${value}`);
  }
  if (url.search || url.hash) {
    throw new HostOperationCliUsageError(
      "invalid_base_url",
      `Bridge API base URL must not contain a query or fragment: ${value}`,
    );
  }
  return value.replace(/\/+$/u, "");
}

function parseJsonObject(value: string, owner: string): Record<string, unknown> {
  const parsed = parseJson(value, owner);
  if (!isRecord(parsed)) {
    throw new HostOperationCliUsageError("invalid_option_value", `${owner} requires a JSON object.`);
  }
  return { ...parsed };
}

function parseJson(value: string, owner: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new HostOperationCliUsageError("invalid_json", `${owner} requires valid JSON.`);
  }
}

function schemaType(schema: Readonly<Record<string, unknown>>): string | undefined {
  const normalized = nonNullSchema(schema);
  if (normalized !== schema) return schemaType(normalized);
  if (typeof schema.type === "string") return schema.type;
  if (Array.isArray(schema.type)) {
    return schema.type.find((value): value is string => typeof value === "string" && value !== "null");
  }
  return undefined;
}

function nonNullSchema(schema: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  if (!Array.isArray(schema.anyOf)) return schema;
  const variants = schema.anyOf.filter(isRecord);
  const nonNullVariants = variants.filter((variant) => schemaType(variant) !== "null");
  return nonNullVariants.length === 1 ? nonNullVariants[0]! : schema;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function looksLikeJsonArray(value: string): boolean {
  return value.trimStart().startsWith("[");
}

function looksLikeJson(value: string): boolean {
  return /^(?:\{|\[|true$|false$|null$|-?\d)/u.test(value.trim());
}

function kebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .replace(/_/gu, "-")
    .toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
