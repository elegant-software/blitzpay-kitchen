export interface Station { id: string; name: string; }

export function stationPath(stationId: string, path: string): string {
  if (!stationId) throw new Error('Select a preparation station first');
  return `/stations/${encodeURIComponent(stationId)}${path}`;
}

/**
 * A screen shows its pinned station (KITCHEN_STATION_ID) or else the branch's default station: the
 * first one, which also receives items without a category or product assignment. No picker.
 */
export function resolveStation(stations: Station[], pinned: string): Station | null {
  if (pinned) return stations.find(station => station.id === pinned) ?? null;
  return stations[0] ?? null;
}
