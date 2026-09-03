import { z } from "zod";

export type HostHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type HostOperationRisk = "read" | "write" | "high-risk-write";

export type HostOperationResponse = Readonly<{
  status: number;
  body?: z.ZodType;
  description?: string;
  schemaId?: string;
}>;

export type HostOperation = Readonly<{
  id: string;
  summary: string;
  description: string;
  method: HostHttpMethod;
  path: string;
  risk: HostOperationRisk;
  params?: z.ZodObject;
  query?: z.ZodObject;
  body?: z.ZodObject;
  success: HostOperationResponse;
  errors?: readonly HostOperationResponse[];
}>;

export type HostOperationParams<TOperation extends HostOperation> = TOperation extends {
  params: infer TSchema extends z.ZodType;
}
  ? z.input<TSchema>
  : never;

export type HostOperationQuery<TOperation extends HostOperation> = TOperation extends {
  query: infer TSchema extends z.ZodType;
}
  ? z.input<TSchema>
  : never;

export type HostOperationBody<TOperation extends HostOperation> = TOperation extends {
  body: infer TSchema extends z.ZodType;
}
  ? z.input<TSchema>
  : never;

type HostOperationInputPart<TOperation extends HostOperation, TKey extends "params" | "query" | "body"> =
  TOperation extends Record<TKey, infer TSchema extends z.ZodType> ? z.input<TSchema> : unknown;

export type HostOperationInput<TOperation extends HostOperation> = HostOperationInputPart<TOperation, "params"> &
  HostOperationInputPart<TOperation, "query"> &
  HostOperationInputPart<TOperation, "body">;

export type HostOperationOutput<TOperation extends HostOperation> = TOperation["success"] extends {
  body: infer TSchema extends z.ZodType;
}
  ? z.output<TSchema>
  : undefined;

type HostOperationDecodedPart<TOperation extends HostOperation, TKey extends "params" | "query" | "body"> =
  TOperation extends Record<TKey, infer TSchema extends z.ZodType>
    ? { readonly [TPart in TKey]: z.output<TSchema> }
    : { readonly [TPart in TKey]?: never };

export type HostOperationDecodedInput<TOperation extends HostOperation> = HostOperationDecodedPart<
  TOperation,
  "params"
> &
  HostOperationDecodedPart<TOperation, "query"> &
  HostOperationDecodedPart<TOperation, "body">;

export function defineHostOperation<const TOperation extends HostOperation>(operation: TOperation): TOperation {
  return operation;
}

export type HostOperationResource = Readonly<{
  id: string;
  title: string;
  description: string;
  operations: readonly HostOperation[];
}>;

export type HostOperationGroup = Readonly<{
  id: string;
  title: string;
  description: string;
  resources: readonly HostOperationResource[];
}>;

export function defineHostOperationResource<const TResource extends HostOperationResource>(
  resource: TResource,
): TResource {
  return resource;
}

export function defineHostOperationGroup<const TGroup extends HostOperationGroup>(group: TGroup): TGroup {
  return group;
}
