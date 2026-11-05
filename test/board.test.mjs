import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Board } from '../dist/renderer/board.js';

const now = new Date();
const item = (id, quantity = 1, locked = false) => ({ itemId: id, name: id, quantity, locked });
const order = (id, extra = {}) => ({ orderId: id, orderCode: id, pickupNumber: 1,
  orderType: 'PRE_ORDER', receivedAt: now.toISOString(), preparationStatus: 'RECEIVED',
  cancelled: false, items: [item('pide')], ...extra });
const setup = (post = async () => {}) => { const b = new Board(new Set(), post); b.online = true; return b; };

test('30 orders sort oldest first; arrivals, changes and filters preserve focus', () => {
  const b = setup();
  b.sync(Array.from({ length: 30 }, (_, n) => order(String(n), { receivedAt: new Date(+now - n * 1000).toISOString() })));
  assert.equal(b.focused, '29');
  b.select('4'); b.filter = 'PREPARING';
  b.receive(order('arrival')); b.receive(order('10', { items: [item('pide', 4)] }));
  assert.equal(b.focused, '4');
  assert.equal(b.cards.get('arrival').isNew, true);
  assert.equal(b.queue.length, 0);
  b.filter = 'RECEIVED';
  assert.equal(b.queue.length, 31);
});

test('viewing clears Unseen only; item changes require explicit acknowledgement', async () => {
  const posts = []; const b = setup(async (...args) => { posts.push(args); });
  b.sync([order('a')]); b.receive(order('b')); b.select('b');
  assert.equal(b.cards.get('b').isNew, false);
  b.receive(order('b', { items: [item('pide', 3)] })); b.select('b');
  assert.ok(b.cards.get('b').baseline);
  await b.advance('b'); assert.equal(posts.length, 0);
  b.acknowledge('b'); await b.advance('b');
  assert.deepEqual(posts, [['b', 'PREPARING']]);
  assert.equal(b.cards.get('b').order.preparationStatus, 'PREPARING');
  assert.equal(b.pending.size, 0);
});

test('cancellations survive every filter, snapshots and status updates until dismissal', async () => {
  const b = setup(); b.sync([order('a'), order('b')]);
  b.receive(order('b', { cancelled: true }));
  assert.equal(b.focused, 'a'); b.select('b');
  for (const filter of ['all', 'RECEIVED', 'PREPARING']) {
    b.filter = filter; assert.ok(b.queue.some(c => c.order.orderId === 'b'));
  }
  b.sync([order('a'), order('b', { preparationStatus: 'READY' })]);
  assert.equal(b.cards.get('b').order.cancelled, true);
  assert.equal(b.focused, 'b'); assert.equal(b.canAdvance('b'), false);
  b.dismiss('b'); assert.equal(b.focused, 'a'); assert.ok(b.dismissed.has('b'));
  b.receive(order('b', { cancelled: true })); assert.equal(b.cards.has('b'), false);
});

test('Ready selects oldest across filters; Undo preserves new focus and sends nothing', async () => {
  const posts = []; const b = setup(async (...args) => { posts.push(args); });
  b.sync([order('a', { preparationStatus: 'PREPARING' }), order('b')]);
  b.filter = 'PREPARING'; await b.advance('a', 1000);
  assert.equal(b.focused, 'b'); assert.equal(b.filter, 'all'); assert.equal(b.reveal, true);
  b.undo('a', 10999); await b.flush(12000);
  assert.equal(b.focused, 'b'); assert.equal(b.cards.has('a'), true); assert.equal(posts.length, 0);
});

test('Ready sends at 10 seconds; expired Undo cannot restore it', async () => {
  const posts = []; const b = setup(async (...args) => { posts.push(args); });
  b.sync([order('a', { preparationStatus: 'PREPARING' })]); await b.advance('a', 1000);
  assert.equal(b.focused, null); await b.flush(10999); assert.equal(posts.length, 0);
  b.undo('a', 11000); assert.equal(b.pending.size, 1);
  await b.flush(11000); assert.deepEqual(posts, [['a', 'READY']]); assert.equal(b.cards.size, 0);
});

test('failed status updates retain orders and require explicit retry', async () => {
  let fail = true;
  const b = setup(async () => { if (fail) throw Error('network'); });
  b.sync([order('a')]); await b.advance('a');
  assert.equal(b.cards.get('a').order.preparationStatus, 'RECEIVED'); assert.equal(b.failures.get('a'), 'PREPARING');
  fail = false; await b.retry('a');
  assert.equal(b.failures.size, 0); assert.equal(b.cards.get('a').order.preparationStatus, 'PREPARING');
  fail = true; await b.advance('a', 0); await b.flush(10000);
  assert.ok(b.cards.has('a')); assert.equal(b.failures.get('a'), 'READY');
  fail = false; await b.retry('a'); assert.equal(b.cards.has('a'), false);
});

test('offline retains orders, blocks actions and retains expired Ready for retry', async () => {
  let posts = 0; const b = setup(async () => { posts++; });
  b.sync([order('a', { preparationStatus: 'PREPARING' }), order('b')]);
  await b.advance('a', 0); b.online = false;
  await b.advance('b'); await b.flush(10000);
  assert.equal(posts, 0); assert.equal(b.cards.size, 2); assert.equal(b.failures.get('a'), 'READY');
  b.online = true; await b.retry('a'); assert.equal(posts, 1); assert.equal(b.focused, 'b');
});

test('changes or cancellation during Ready Undo restore alerts without stealing focus', async () => {
  const b = setup(); b.sync([order('a', { preparationStatus: 'PREPARING' }), order('b')]);
  await b.advance('a', 0); b.receive(order('a', { items: [item('pide', 2)], preparationStatus: 'PREPARING' }));
  assert.equal(b.pending.size, 0); assert.ok(b.cards.get('a').baseline); assert.equal(b.focused, 'b');
  b.acknowledge('a'); await b.advance('a', 0); b.receive(order('a', { cancelled: true }));
  assert.equal(b.pending.size, 0); assert.equal(b.focused, 'b');
});

test('remote removal selects oldest available; no live order leaves detail empty', () => {
  const b = setup(); b.sync([order('a'), order('b')]);
  b.filter = 'PREPARING'; b.sync([order('b')]);
  assert.equal(b.focused, 'b'); assert.equal(b.filter, 'all');
  b.sync([order('c', { cancelled: true })]); assert.equal(b.focused, null);
});

test('reopened work remains changed until acknowledged and keeps prepared items', () => {
  const b = setup(); b.sync([order('a', { items: [item('old', 1, true), item('extra', 2)] })]);
  assert.deepEqual(b.cards.get('a').baseline, [item('old', 1, true)]);
  assert.equal(b.canAdvance('a'), false); b.acknowledge('a');
  assert.equal(b.canAdvance('a'), true); assert.equal(b.cards.get('a').order.items[0].locked, true);
});

test('late success never clears changes or cancellation received during a request', async () => {
  let finish; const b = setup(() => new Promise(r => { finish = r; }));
  b.sync([order('a')]); const request = b.advance('a');
  b.receive(order('a', { items: [item('extra', 3)] })); finish(); await request;
  assert.ok(b.cards.get('a').baseline);
  b.acknowledge('a'); const request2 = b.advance('a');
  b.receive(order('a', { cancelled: true })); finish(); await request2;
  assert.equal(b.cards.get('a').order.cancelled, true);
});
