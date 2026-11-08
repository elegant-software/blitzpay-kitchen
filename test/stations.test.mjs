import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stationPath, resolveStation } from '../dist/renderer/stations.js';

test('each station uses its own snapshot, stream and completion URLs', () => {
  assert.equal(stationPath('food', '/orders'), '/stations/food/orders');
  assert.equal(stationPath('drinks', '/stream'), '/stations/drinks/stream');
  assert.equal(stationPath('drinks', '/orders/42/preparation-status'), '/stations/drinks/orders/42/preparation-status');
});

test('a saved or configured station must exist in the authorized station list', () => {
  const stations = [{ id: 'food', name: 'Food Kitchen' }, { id: 'drinks', name: 'Drinks Bar' }];
  assert.equal(resolveStation(stations, 'drinks')?.id, 'drinks');
  assert.equal(resolveStation(stations, 'other-branch'), null);
  assert.equal(resolveStation(stations, ''), null);
  assert.equal(resolveStation([stations[0]], '')?.id, 'food');
});
