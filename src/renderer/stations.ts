export interface Station { id: string; name: string; }

export function stationPath(stationId: string, path: string): string {
  if (!stationId) throw new Error('Select a preparation station first');
  return `/stations/${encodeURIComponent(stationId)}${path}`;
}

export function resolveStation(stations: Station[], selected: string): Station | null {
  if (selected) return stations.find(station => station.id === selected) ?? null;
  return stations.length === 1 ? stations[0] : null;
}
