import type { SupportedLocale } from "./locale-registry.js";
import { EN_HOST_MESSAGES } from "./locales/en.js";
import { ZH_CN_HOST_MESSAGES } from "./locales/zh-CN.js";
import {
  messageDescriptor,
  renderMessageDescriptor,
  type MessageDescriptor,
  type MessageParams,
} from "./message-descriptor.js";

export type HostMessageCode = keyof typeof EN_HOST_MESSAGES;

export const HOST_MESSAGE_CATALOGS = {
  "zh-CN": ZH_CN_HOST_MESSAGES,
  en: EN_HOST_MESSAGES,
} satisfies Record<SupportedLocale, Record<HostMessageCode, string>>;

export function hostMessage(locale: SupportedLocale, code: HostMessageCode, params?: MessageParams): string {
  return renderMessageDescriptor(HOST_MESSAGE_CATALOGS, locale, messageDescriptor(code, params));
}

export function renderHostMessage(locale: SupportedLocale, descriptor: MessageDescriptor<HostMessageCode>): string {
  return renderMessageDescriptor(HOST_MESSAGE_CATALOGS, locale, descriptor);
}
