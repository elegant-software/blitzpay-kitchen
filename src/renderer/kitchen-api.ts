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
    // Valid login, wrong branch (e.g. KITCHEN_BRANCH_ID changed but the saved login is another branch's):
    // retrying never helps, so drop the saved login and ask for this branch's one.
    if (response.status === 403 && !session.mock) {
      await session.login();
      throw new Error("This kitchen login is not allowed for this branch. Sign in with this branch's kitchen login.");
    }
    const request = `${init.method ?? 'GET'} ${path}`;
    if (response.status === 404) throw new Error(`${request}: 404. Check KITCHEN_BRANCH_ID, KITCHEN_STATION_ID and that the backend supports kitchen screens.`);
    if (response.status >= 500) throw new Error(`${request}: ${response.status}. The backend failed; check its logs.`);
    if (!response.ok) throw new Error(`${request}: ${response.status}`);
    return response;
  };
}
