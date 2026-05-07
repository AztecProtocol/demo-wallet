import {
  AUTO_LOCK_ALARM,
  DEFAULT_AUTO_LOCK_MINUTES,
  SETTINGS_KEY,
} from "../shared/constants";

interface Settings {
  autoLockMinutes?: number;
}

async function getMinutes(): Promise<number> {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = (result[SETTINGS_KEY] as Settings | undefined) ?? {};
  return settings.autoLockMinutes ?? DEFAULT_AUTO_LOCK_MINUTES;
}

export async function bumpActivity(): Promise<void> {
  const minutes = await getMinutes();
  await chrome.alarms.clear(AUTO_LOCK_ALARM);
  await chrome.alarms.create(AUTO_LOCK_ALARM, { delayInMinutes: minutes });
}

export async function cancelAutoLock(): Promise<void> {
  await chrome.alarms.clear(AUTO_LOCK_ALARM);
}

export function onAutoLockFired(handler: () => void): void {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === AUTO_LOCK_ALARM) handler();
  });
}
