import { hostMessage } from "../../localization/host-messages.js";
import { DEFAULT_LOCALE, type SupportedLocale } from "../../localization/locale-registry.js";

export const ROOM_RUN_SESSION_SCHEMA_VERSION = "v7";

export function roomRunCanceledMessage(language: SupportedLocale = DEFAULT_LOCALE): string {
  return hostMessage(language, "room.run_canceled");
}

export function roomRunFailedMessage(language: SupportedLocale = DEFAULT_LOCALE): string {
  return hostMessage(language, "room.run_failed");
}
