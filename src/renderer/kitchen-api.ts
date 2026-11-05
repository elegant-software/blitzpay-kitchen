import { fetchService } from './connections.js';

export interface KitchenSession {
  mock: boolean;
  headers(forceRefresh: boolean): Promise<Record<string, string>>;
  login(): Promise<void>;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function createKitchenApi(base: string, session: KitchenSession, fetcher: Fetcher = fetch) {
  return async (path: string, init: RequestInit = {}): Promise<Response> => {
    const send = async (forceRefresh: boolean) => {
      const headers = new Headers(init.headers);
      for (const [key, value] of Object.entries(await session.headers(forceRefresh))) headers.set(key, value);
      return fetchService(base + path, 'Kitchen API', { ...init, headers }, fetcher);
    };
    let response = await send(false);
    if (response.status === 401) {
      if (session.mock) throw new Error('The kitchen API requires login, but mock authentication is enabled. Set MOCK_AUTH=0 in this terminal and restart the screen.');
      response = await send(true);
      if (response.status === 401) {
        await session.login();
        throw new Error('The kitchen session was rejected. Sign in again with the branch kitchen login.');
      }
    }
    if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${response.status}`);
    return response;
  };
}
