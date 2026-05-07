import { REMEMBERED_APPS_KEY } from "../shared/constants";

export interface RememberedApp {
  appId: string;
  origin: string;
  rememberedAt: number;
  /** Chain ID as hex string */
  chainId: string;
  /** Network version as hex string */
  version: string;
}

export async function getRememberedApps(): Promise<RememberedApp[]> {
  if (!chrome?.storage?.local) return [];
  const result = await chrome.storage.local.get(REMEMBERED_APPS_KEY);
  const apps = (result[REMEMBERED_APPS_KEY] as RememberedApp[] | undefined) ?? [];
  // Filter out old format entries that don't have chainId/version
  return apps.filter((app) => app.chainId && app.version);
}

export async function isAppRemembered(
  appId: string,
  origin: string,
  chainId: string,
  version: string,
): Promise<boolean> {
  const apps = await getRememberedApps();
  return apps.some(
    (a) =>
      a.appId === appId && a.origin === origin && a.chainId === chainId && a.version === version,
  );
}

export async function rememberApp(
  appId: string,
  origin: string,
  chainId: string,
  version: string,
): Promise<void> {
  if (!chrome?.storage?.local) return;
  const apps = await getRememberedApps();
  if (
    !apps.some(
      (a) =>
        a.appId === appId && a.origin === origin && a.chainId === chainId && a.version === version,
    )
  ) {
    apps.push({ appId, origin, rememberedAt: Date.now(), chainId, version });
    await chrome.storage.local.set({ [REMEMBERED_APPS_KEY]: apps });
  }
}

export async function forgetApp(
  appId: string,
  origin: string,
  chainId: string,
  version: string,
): Promise<void> {
  if (!chrome?.storage?.local) return;
  const apps = await getRememberedApps();
  const filtered = apps.filter(
    (a) =>
      !(a.appId === appId && a.origin === origin && a.chainId === chainId && a.version === version),
  );
  await chrome.storage.local.set({ [REMEMBERED_APPS_KEY]: filtered });
}
