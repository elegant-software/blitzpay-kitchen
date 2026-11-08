export interface ConnectionConfig {
  apiBaseUrl: string;
  branchId: string;
  keycloakUrl: string;
  keycloakRealm: string;
  keycloakClientId: string;
  mockAuth: boolean;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function validateConnectionConfig(config: ConnectionConfig): void {
  if (!config.branchId?.trim() || (!config.mockAuth && config.branchId === 'demo-branch')) {
    throw new Error('Kitchen connection is not configured. Set KITCHEN_BRANCH_ID to your real branch and configure KITCHEN_API_URL / KEYCLOAK_URL in .env.');
  }
  if (!config.mockAuth) {
    for (const [name, value] of [['KEYCLOAK_REALM', config.keycloakRealm], ['KEYCLOAK_CLIENT_ID', config.keycloakClientId]]) {
      if (!value?.trim()) throw new Error(`${name} is missing. Set it in .env and restart the kitchen screen.`);
    }
  }
  for (const [name, value] of [['KITCHEN_API_URL', config.apiBaseUrl], ...(!config.mockAuth ? [['KEYCLOAK_URL', config.keycloakUrl]] : [])]) {
    try {
      if (!['http:', 'https:'].includes(new URL(value).protocol)) throw new Error();
    } catch { throw new Error(`${name} must be a valid http:// or https:// address.`); }
  }
}

export async function fetchService(url: string, service: string, init: RequestInit = {}, fetcher: Fetcher = fetch): Promise<Response> {
  try { return await fetcher(url, { ...init, signal: init.signal ?? AbortSignal.timeout(10000) }); }
  catch { throw new Error(`Cannot reach ${service} at ${url}. Check the server address, network and that the service is running.`); }
}

export async function verifyKeycloak(config: ConnectionConfig, fetcher: Fetcher = fetch): Promise<void> {
  if (config.mockAuth) return;
  const url = `${config.keycloakUrl.replace(/\/+$/, '')}/realms/${encodeURIComponent(config.keycloakRealm)}/.well-known/openid-configuration`;
  const response = await fetchService(url, 'Keycloak', {}, fetcher);
  if (!response.ok) throw new Error(`Keycloak realm at ${url} returned HTTP ${response.status}. Check KEYCLOAK_URL and KEYCLOAK_REALM.`);
  let discovery: { issuer?: string };
  try { discovery = await response.json(); }
  catch { throw new Error(`Keycloak realm at ${url} did not return valid discovery JSON. Check KEYCLOAK_URL.`); }
  if (!discovery.issuer) throw new Error(`Keycloak realm at ${url} did not return an issuer. Check KEYCLOAK_URL.`);
}
