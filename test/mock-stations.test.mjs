import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { stationPath } from '../dist/renderer/stations.js';

test('two displays retain #42 and Table 7 while completion and reconnect stay independent', async () => {
  const child = spawn(process.execPath, ['mock/server.mjs'], { env: { ...process.env, PORT: '0', EVENT_SECONDS: '60000' }, windowsHide: true });
  try {
    const port = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('mock did not start')), 10000);
      child.once('error', reject);
      child.stdout.on('data', data => {
        const match = String(data).match(/localhost:(\d+)/);
        if (match) { clearTimeout(timeout); resolve(match[1]); }
      });
    });
    const base = `http://localhost:${port}/v1/merchant/branches/demo/kitchen`;
    const request = async (path, status) => {
      const response = await fetch(base + path, status ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) } : {});
      assert.equal(response.status, 200);
      return response.json();
    };
    const stations = await request('/stations');
    const food = stations.find(s => s.name === 'Food Kitchen').id;
    const drinks = stations.find(s => s.name === 'Drinks Bar').id;
    const foodTicket = (await request(stationPath(food, '/orders'))).find(o => o.pickupNumber === 42);
    const drinksTicket = (await request(stationPath(drinks, '/orders'))).find(o => o.pickupNumber === 42);
    assert.equal(foodTicket.orderId, drinksTicket.orderId);
    assert.equal(drinksTicket.tableName, 'Table 7');
    assert.equal(drinksTicket.fulfilmentType, 'TAKE_AWAY');
    assert.deepEqual(foodTicket.items.map(i => [i.name, i.quantity]), [['Burger', 2]]);
    assert.deepEqual(drinksTicket.items.map(i => [i.name, i.quantity]), [['Cola', 2]]);
    const completion = stationPath(drinks, `/orders/${drinksTicket.orderId}/preparation-status`);
    await request(completion, 'PREPARING');
    await request(completion, 'READY');
    await request(completion, 'READY');
    assert.equal((await request(stationPath(drinks, '/orders'))).some(o => o.pickupNumber === 42), false);
    assert.equal((await request(stationPath(food, '/orders'))).find(o => o.pickupNumber === 42).preparationStatus, 'RECEIVED');
  } finally { child.kill(); }
});
