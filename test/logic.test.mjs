import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOrder, diffItems, reconcile, sorted } from '../dist/renderer/logic.js';

const now = new Date();
const item = (itemId, quantity, locked = false) => ({ itemId, name: itemId, quantity, locked });
const order = (id, items, extra = {}) => ({
  orderId: id, orderCode: 'C', pickupNumber: 1, orderType: 'PRE_ORDER',
  receivedAt: now.toISOString(), preparationStatus: 'RECEIVED', cancelled: false, items, ...extra,
});
const opts = (markNew = true) => ({ markNew, dismissed: new Set(), now });

test('diffItems marks added, changed and removed lines', () => {
  const lines = diffItems([item('a', 1), item('b', 2), item('c', 1)], [item('a', 1), item('b', 3), item('d', 1)]);
  assert.deepEqual(lines.map((l) => [l.name, l.kind, l.prevQuantity]), [
    ['a', 'same', undefined], ['b', 'changed', 2], ['d', 'added', undefined], ['c', 'removed', undefined],
  ]);
  assert.deepEqual(diffItems(null, [item('a', 1)]).map((l) => l.kind), ['same']);
});

test('changes accumulate against the last acknowledged items', () => {
  const cards = new Map();
  assert.equal(applyOrder(cards, order('o', [item('a', 1)]), opts()), 'new');
  assert.equal(applyOrder(cards, order('o', [item('a', 2)]), opts()), 'changed');
  assert.equal(applyOrder(cards, order('o', [item('a', 3)]), opts()), 'changed');
  assert.deepEqual(cards.get('o').baseline, [item('a', 1)]); // still vs. the original until tapped
  // A status-only change is not a "change".
  assert.equal(applyOrder(cards, order('o', [item('a', 3)], { preparationStatus: 'PREPARING' }), opts()), 'none');
});

test('READY removes, cancelled shows until dismissed, old days are hidden', () => {
  const cards = new Map();
  applyOrder(cards, order('o', [item('a', 1)]), opts());
  assert.equal(applyOrder(cards, order('o', [item('a', 1)], { preparationStatus: 'READY' }), opts()), 'removed');
  assert.equal(cards.size, 0);

  assert.equal(applyOrder(cards, order('c', [item('a', 1)], { cancelled: true }), opts()), 'cancelled');
  assert.equal(applyOrder(cards, order('c', [item('a', 1)], { cancelled: true }), opts()), 'none');
  const dismissed = { ...opts(), dismissed: new Set(['x']) };
  assert.equal(applyOrder(cards, order('x', [], { cancelled: true }), dismissed), 'none');

  const yesterday = new Date(now.getTime() - 86_400_000).toISOString();
  assert.equal(applyOrder(cards, order('y', [item('a', 1)], { receivedAt: yesterday }), opts()), 'none');
  assert.equal(cards.has('y'), false);
});

test('an order returning from READY highlights only non-locked items', () => {
  const cards = new Map();
  assert.equal(applyOrder(cards, order('o', [item('a', 1, true), item('b', 1)]), opts()), 'changed');
  assert.deepEqual(diffItems(cards.get('o').baseline, cards.get('o').order.items).map((l) => [l.kind, l.locked]),
    [['same', true], ['added', false]]);
});

test('reconcile drops orders closed elsewhere, keeps cancelled and unacknowledged highlights', () => {
  const cards = new Map();
  reconcile(cards, [order('a', [item('x', 1)]), order('b', [item('x', 1)]), order('c', [], { cancelled: true })], opts(false));
  assert.equal(cards.get('a').isNew, false); // first load: no highlight
  applyOrder(cards, order('a', [item('x', 2)]), opts());

  const out = reconcile(cards, [order('a', [item('x', 2)]), order('d', [item('x', 1)])], opts(true));
  assert.deepEqual(out, ['none', 'new']);
  assert.deepEqual([...cards.keys()].sort(), ['a', 'c', 'd']); // b gone, cancelled c kept
  assert.deepEqual(cards.get('a').baseline, [item('x', 1)]);
});

test('sorted is oldest first', () => {
  const cards = new Map();
  applyOrder(cards, order('new', [], { receivedAt: now.toISOString() }), opts());
  applyOrder(cards, order('old', [], { receivedAt: new Date(now.getTime() - 60_000).toISOString() }), opts());
  assert.deepEqual(sorted(cards).map((c) => c.order.orderId), ['old', 'new']);
});
