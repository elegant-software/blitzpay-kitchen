type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

// Packaged builds carry the release tag: cd-release.yml stamps package.json with `npm version <tag without v>`.
export function appVersion(isPackaged: boolean, version: string): string {
  return isPackaged ? `v${version}` : 'dev';
}

// Public actuator endpoint of the backend. Any failure is "unknown": the version must never block the orders.
export async function backendVersion(apiBaseUrl: string, fetcher: Fetcher = fetch, timeoutMs = 5000): Promise<string> {
  try {
    const res = await fetcher(`${apiBaseUrl.replace(/\/+$/, '')}/actuator/info`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return 'unknown';
    const version = (await res.json())?.build?.version;
    return typeof version === 'string' && version ? version : 'unknown';
  } catch {
    return 'unknown';
  }
}
