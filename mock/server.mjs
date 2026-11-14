// Zero-dependency mock of the Kitchen Screen backend API.
// Emits a random order.created / order.changed / order.cancelled event every EVENT_SECONDS (default 15).
// Trigger one by hand: curl -X POST localhost:8787/mock/created   (or changed | cancelled | reopen)
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 8787);
const EVENT_SECONDS = Number(process.env.EVENT_SECONDS ?? 15);
const MENU = ['Margherita', 'Burger Classic', 'Pommes', 'Caesar Salad', 'Falafel Wrap', 'Cola 0,5l', 'Cappuccino', 'Brownie'];
const NAMES = ['Anna', 'Lukas', 'Mia', 'Jonas', undefined, undefined];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

const orders = new Map();
const clients = new Set();
let pickup = 41;
const FOOD = '44444444-4444-4444-4444-444444444441';
const DRINKS = '44444444-4444-4444-4444-444444444442';
const stations = [{ id: FOOD, name: 'Food Kitchen' }, { id: DRINKS, name: 'Drinks Bar' }];
const clientStations = new Map();
const progress = items => items.length === 0 || items.every(i => i.locked || i.preparationStatus === 'READY') ? 'READY'
  : items.some(i => i.locked || i.preparationStatus !== 'RECEIVED') ? 'PREPARING' : 'RECEIVED';
function ticket(order, stationId) {
  if (!stationId) return order;
  const items = order.items.filter(i => i.stationId === stationId);
  return { ...order, items, preparationStatus: progress(items), cancelled: order.cancelled && items.length > 0 };
}

function newOrder(minutesAgo = 0) {
  const o = {
    orderId: randomUUID(),
    orderCode: `BP-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    pickupNumber: ++pickup,
    orderType: Math.random() < 0.5 ? 'PRE_ORDER' : 'WALK_IN_ORDERING',
    shopperFirstName: pick(NAMES),
    fulfilmentType: Math.random() < 0.5 ? 'DINE_IN' : 'TAKE_AWAY',
    receivedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    preparationStatus: 'RECEIVED',
    cancelled: false,
    items: [],
  };
  const n = 1 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) addItem(o);
  orders.set(o.orderId, o);
  return o;
}

function addItem(o) {
  const name = pick(MENU.filter((m) => !o.items.some((i) => i.name === m)));
  const stationId = /Cola|Cappuccino/.test(name) ? DRINKS : FOOD;
  o.items.push({ itemId: randomUUID(), name, quantity: 1 + Math.floor(Math.random() * 2), locked: false,
    stationId, stationName: stations.find(s => s.id === stationId).name, preparationStatus: 'RECEIVED' });
}

const open = () => [...orders.values()].filter((o) => o.preparationStatus !== 'READY' && !o.cancelled);

function emit(event, o) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(o)}\n\n`;
  for (const res of clients) {
    const selected = clientStations.get(res);
    const stationTicket = selected ? ticket(o, selected) : o;
    const stationEvent = selected && !stationTicket.items.length ? 'order.changed' : event;
    res.write(selected ? `event: ${stationEvent}\ndata: ${JSON.stringify(stationTicket)}\n\n` : msg);
  }
  console.log(event, `#${o.pickupNumber}`, o.preparationStatus, o.items.map((i) => `${i.quantity}x ${i.name}${i.locked ? ' (locked)' : ''}`).join(', '));
}

const triggers = {
  created: () => emit('order.created', newOrder()),
  changed: () => {
    const o = pick(open());
    if (!o) return triggers.created();
    const r = Math.random();
    const editable = o.items.filter(item => !item.locked);
    if (r < 0.4 || !editable.length) addItem(o);
    else if (r < 0.7 || editable.length < 2) pick(editable).quantity += 1;
    else o.items.splice(o.items.indexOf(pick(editable)), 1);
    o.preparationStatus = progress(o.items);
    emit('order.changed', o);
  },
  cancelled: () => {
    const o = pick(open());
    if (!o) return triggers.created();
    o.cancelled = true;
    emit('order.cancelled', o);
  },
  // An item added to a READY order: existing items lock, order returns to RECEIVED.
  reopen: () => {
    const o = pick([...orders.values()].filter((x) => x.preparationStatus === 'READY' && !x.cancelled));
    if (!o) return triggers.changed();
    o.items.forEach((i) => (i.locked = true));
    addItem(o);
    o.preparationStatus = 'RECEIVED';
    emit('order.changed', o);
  },
};

// Seed: a few open orders (one already overdue) and one from yesterday the screen must hide.
const mixed = newOrder(22);
mixed.tableName = 'Table 7';
mixed.fulfilmentType = 'TAKE_AWAY'; // a take-away order can still have a table
mixed.items = [
  { itemId: randomUUID(), name: 'Burger', quantity: 2, locked: false, stationId: FOOD, stationName: 'Food Kitchen', preparationStatus: 'RECEIVED' },
  { itemId: randomUUID(), name: 'Cola', quantity: 2, locked: false, stationId: DRINKS, stationName: 'Drinks Bar', preparationStatus: 'RECEIVED' },
];
newOrder(6);
const preparing = newOrder(1);
preparing.preparationStatus = 'PREPARING';
preparing.items.forEach(item => { item.preparationStatus = 'PREPARING'; });
newOrder(60 * 24 + 5);

setInterval(() => {
  const r = Math.random();
  triggers[r < 0.45 ? 'created' : r < 0.75 ? 'changed' : r < 0.85 ? 'cancelled' : 'reopen']();
}, EVENT_SECONDS * 1000);

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
};

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.end();

  let path = new URL(req.url, 'http://x').pathname;
  const stationMatch = path.match(/^(.*\/kitchen)\/stations\/([^/]+)(\/.*)$/);
  const stationId = stationMatch?.[2];
  if (stationId && !stations.some(s => s.id === stationId)) return json(res, 404, { error: 'station not found' });
  if (stationMatch) path = stationMatch[1] + stationMatch[3];
  if (req.method === 'GET' && /\/kitchen\/stations$/.test(path)) return json(res, 200, stations);
  let m;
  if (req.method === 'GET' && /^\/v1\/merchant\/branches\/[^/]+\/kitchen\/orders$/.test(path)) {
    // Like the real endpoint should: today's open orders plus cancelled ones (the screen tracks dismissal).
    return json(res, 200, [...orders.values()].map(o => ticket(o, stationId)).filter(o => o.items.length && (o.cancelled || o.preparationStatus !== 'READY')));
  }
  if (req.method === 'GET' && /^\/v1\/merchant\/branches\/[^/]+\/kitchen\/branding$/.test(path)) {
    return json(res, 200, { logoUrl: process.env.MOCK_LOGO_URL ?? null, language: process.env.MOCK_LANGUAGE ?? null });
  }
  if (req.method === 'GET' && /^\/v1\/merchant\/branches\/[^/]+\/kitchen\/stream$/.test(path)) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    clients.add(res);
    if (stationId) clientStations.set(res, stationId);
    req.on('close', () => (clearInterval(ping), clients.delete(res), clientStations.delete(res)));
    return;
  }
  if (req.method === 'POST' && (m = path.match(/^\/v1\/merchant\/branches\/[^/]+\/kitchen\/orders\/([^/]+)\/preparation-status$/))) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const o = orders.get(m[1]);
      const { status } = JSON.parse(body || '{}');
      if (!o) return json(res, 404, { error: 'order not found' });
      if (!['PREPARING', 'READY'].includes(status)) return json(res, 400, { error: 'invalid status' });
      if (o.cancelled) return json(res, 409, { error: 'order cancelled' });
      const current = ticket(o, stationId);
      if (!current.items.length) return json(res, 404, { error: 'station ticket not found' });
      if (current.preparationStatus !== status && !(
        current.preparationStatus === 'RECEIVED' && status === 'PREPARING' || current.preparationStatus === 'PREPARING' && status === 'READY'
      )) return json(res, 409, { error: 'invalid transition' });
      current.items.filter(i => !i.locked).forEach(i => { i.preparationStatus = status; if (status === 'READY') i.locked = true; });
      o.preparationStatus = progress(o.items);
      json(res, 200, ticket(o, stationId));
      emit('order.changed', o);
    });
    return;
  }
  if (req.method === 'POST' && (m = path.match(/^\/mock\/(\w+)$/)) && triggers[m[1]]) {
    triggers[m[1]]();
    return json(res, 204);
  }
  json(res, 404, { error: 'not found' });
}).listen(PORT, function () { console.log(`Kitchen mock API on http://localhost:${this.address().port} (event every ${EVENT_SECONDS}s)`); });
