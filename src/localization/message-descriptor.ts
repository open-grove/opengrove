import type { SupportedLocale } from "./locale-registry.js";

export type MessageParam = string | number;
export type MessageParams = Readonly<Record<string, MessageParam>>;

export interface MessageDescriptor<Code extends string = string> {
  code: Code;
  params?: MessageParams;
}

export type MessageCatalog<Code extends string> = Readonly<Record<Code, string>>;

export function messageDescriptor<Code extends string>(code: Code, params?: MessageParams): MessageDescriptor<Code> {
  return params && Object.keys(params).length ? { code, params } : { code };
}

export function renderMessageDescriptor<Code extends string>(
  catalogs: Readonly<Record<SupportedLocale, MessageCatalog<Code>>>,
  locale: SupportedLocale,
  descriptor: MessageDescriptor<Code>,
): string {
  const template = catalogs[locale][descriptor.code];
  const params = descriptor.params ?? {};
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}
