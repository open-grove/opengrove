import { APP_STORAGE_KEYS } from "../identity";
import {
  claimDailyClientActivityAttemptForKey,
  desktopClientActivityWindowIsForeground,
  desktopClientActivityReport,
  millisecondsUntilNextUtcDay,
  utcActivityDay,
  type ClientActivityStorage,
} from "./client-activity-policy";

export {
  desktopClientActivityReport,
  desktopClientActivityWindowIsForeground,
  millisecondsUntilNextUtcDay,
  utcActivityDay,
};

export function claimDailyClientActivityAttempt(
  storage: ClientActivityStorage,
  userId: string,
  now = new Date(),
): boolean {
  return claimDailyClientActivityAttemptForKey(storage, APP_STORAGE_KEYS.clientActivityLastAttempt, userId, now);
}
