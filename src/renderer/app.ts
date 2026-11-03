import Keycloak from '../../node_modules/keycloak-js/lib/keycloak.js';
import { applyOrder, diffItems, isToday, reconcile, sorted, type Cards, type KitchenOrder, type Outcome } from './logic.js';

interface Config {
  apiBaseUrl: string;
  branchId: string;
  keycloakUrl: string;
  keycloakRealm: string;
  keycloakClientId: string;
  overdueMinutes: number;
  mockAuth: boolean;
}

declare global {
  interface Window {
    kitchen: {
      config(): Promise<Config>;
      loadToken(): Promise<{ token: string; refreshToken: string } | null>;
      saveToken(t: { token?: string; refreshToken?: string } | null): Promise<void>;
    };
  }
}

const strings = {
  en: {
    PRE_ORDER: 'Pre-Order', WALK_IN_ORDERING: 'Walk-In', RECEIVED: 'Received', PREPARING: 'Preparing',
    toPreparing: 'Preparing', toReady: 'Ready', cancelled: 'CANCELLED', tapToDismiss: 'Tap to dismiss',
    new: 'NEW', undo: 'Undo', offline: 'Offline – reconnecting…', empty: 'No open orders',
  },
  de: {
    PRE_ORDER: 'Vorbestellung', WALK_IN_ORDERING: 'Vor Ort', RECEIVED: 'Eingegangen', PREPARING: 'In Zubereitung',
    toPreparing: 'Zubereiten', toReady: 'Fertig', cancelled: 'STORNIERT', tapToDismiss: 'Tippen zum Schließen',
    new: 'NEU', undo: 'Rückgängig', offline: 'Offline – verbinde neu…', empty: 'Keine offenen Bestellungen',
  },
};
const t = navigator.language.toLowerCase().startsWith('de') ? strings.de : strings.en;
document.documentElement.lang = t === strings.de ? 'de' : 'en';

const UNDO_MS = 10_000;
const cfg = await window.kitchen.config();
const base = `${cfg.apiBaseUrl}/v1/merchant/branches/${encodeURIComponent(cfg.branchId)}/kitchen`;

// ---- Auth ---------------------------------------------------------------

async function setupAuth(): Promise<() => Promise<Record<string, string>>> {
  if (cfg.mockAuth) return async () => ({});
  const kc = new Keycloak({ url: cfg.keycloakUrl, realm: cfg.keycloakRealm, clientId: cfg.keycloakClientId });
  const redirectUri = location.origin + location.pathname;
  const save = () => window.kitchen.saveToken({ token: kc.token, refreshToken: kc.refreshToken });
  kc.onAuthSuccess = save;
  kc.onAuthRefreshSuccess = save;
  kc.onAuthRefreshError = () => {
    // keycloak-js clears the refresh token on HTTP 400 (revoked/expired); network errors keep it.
    if (!kc.refreshToken) window.kitchen.saveToken(null).then(() => kc.login({ redirectUri }));
  };
  kc.onTokenExpired = () => kc.updateToken(30).catch(() => {});
  const saved = await window.kitchen.loadToken();
  const common = { checkLoginIframe: false, pkceMethod: 'S256' as const, scope: 'openid offline_access', redirectUri };
  try {
    // With a saved token keycloak-js refreshes it; without one (or after the login redirect) it handles login.
    await kc.init(saved ? { ...common, ...saved } : { ...common, onLoad: 'login-required' });
  } catch {
    if (!kc.refreshToken) {
      await window.kitchen.saveToken(null);
      await kc.login({ redirectUri, scope: 'openid offline_access' });
    }
    // Otherwise the network is down: keep the token, requests retry the refresh.
  }
  return async () => {
    await kc.updateToken(30);
    return { Authorization: `Bearer ${kc.token}` };
  };
}

const authHeaders = await setupAuth();

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(base + path, { ...init, headers: { ...(await authHeaders()), ...init.headers } });
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${res.status}`);
  return res;
}

const postStatus = (orderId: string, status: 'PREPARING' | 'READY') =>
  api(`/orders/${encodeURIComponent(orderId)}/preparation-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });

// ---- State --------------------------------------------------------------

const cards: Cards = new Map();
const pendingReady = new Map<string, number>(); // orderId -> timeout handle
const flashing = new Set<string>();
const dismissKey = () => `dismissed:${new Date().toDateString()}`;
const dismissed = new Set<string>(JSON.parse(localStorage.getItem(dismissKey()) ?? '[]'));
const opts = (markNew: boolean) => ({ markNew, dismissed, now: new Date() });

function handle(id: string, outcome: Outcome) {
  if (outcome === 'changed' && pendingReady.has(id)) {
    // Items changed during the undo window: don't send READY, bring the card back.
    clearTimeout(pendingReady.get(id));
    pendingReady.delete(id);
  }
  if (outcome === 'removed') {
    clearTimeout(pendingReady.get(id));
    pendingReady.delete(id);
  }
  if (outcome === 'new' || outcome === 'changed' || outcome === 'cancelled') {
    flashing.add(id);
    setTimeout(() => flashing.delete(id), 2000);
    chime();
  }
}

let loaded = false; // first load after start: show orders without chiming
async function resync() {
  const orders: KitchenOrder[] = await (await api('/orders')).json();
  reconcile(cards, orders, opts(loaded)).forEach((outcome, i) => handle(orders[i].orderId, outcome));
  loaded = true;
  render();
}

// ---- Actions ------------------------------------------------------------

function advance(id: string) {
  const card = cards.get(id);
  if (!card) return;
  if (card.order.preparationStatus === 'RECEIVED') {
    card.order.preparationStatus = 'PREPARING';
    postStatus(id, 'PREPARING').catch(() => resync().catch(() => {}));
  } else {
    pendingReady.set(id, window.setTimeout(() => {
      pendingReady.delete(id);
      cards.delete(id);
      postStatus(id, 'READY').catch(() => resync().catch(() => {}));
      render();
    }, UNDO_MS));
  }
  acknowledge(id);
}

function acknowledge(id: string) {
  const card = cards.get(id);
  if (!card) return;
  if (card.order.cancelled) {
    cards.delete(id);
    dismissed.add(id);
    localStorage.setItem(dismissKey(), JSON.stringify([...dismissed]));
  } else {
    card.baseline = null;
    card.isNew = false;
  }
  render();
}

function undo(id: string) {
  clearTimeout(pendingReady.get(id));
  pendingReady.delete(id);
  render();
}

// ---- Rendering ----------------------------------------------------------

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
// ponytail: orders from before the deploy have no pickup number, show the order code
const pickup = (o: KitchenOrder) => (o.pickupNumber == null ? o.orderCode : `#${String(o.pickupNumber).padStart(3, '0')}`);
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function elapsed(receivedAt: string) {
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(receivedAt)) / 1000));
  return { text: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`, overdue: s >= cfg.overdueMinutes * 60 };
}

function render() {
  const visible = sorted(cards).filter((c) => !pendingReady.has(c.order.orderId));
  $('#grid').innerHTML = visible.length
    ? visible.map(({ order: o, baseline, isNew }) => {
        const lines = diffItems(baseline, o.items).map((l) => {
          const qty = l.kind === 'changed' ? `<s>${l.prevQuantity}×</s> ${l.quantity}×` : `${l.quantity}×`;
          const tag = l.kind === 'added' ? ` <b class="tag">${t.new}</b>` : '';
          return `<li class="${l.kind}${l.locked ? ' locked' : ''}"><span class="qty">${qty}</span> ${esc(l.name)}${tag}</li>`;
        }).join('');
        const highlight = isNew || baseline || o.cancelled ? ' highlight' : '';
        const flash = flashing.has(o.orderId) ? ' flash' : '';
        const action = o.cancelled
          ? `<div class="cancelled-label">${t.cancelled}<small>${t.tapToDismiss}</small></div>`
          : `<button class="advance" data-advance="${esc(o.orderId)}">${o.preparationStatus === 'RECEIVED' ? t.toPreparing : t.toReady}</button>`;
        return `<article class="card ${o.preparationStatus.toLowerCase()}${o.cancelled ? ' cancelled' : ''}${highlight}${flash}" data-id="${esc(o.orderId)}">
          <header>
            <span class="pickup">${pickup(o)}</span>
            <span class="timer" data-received="${esc(o.receivedAt)}"></span>
          </header>
          <div class="meta">
            <span class="badge ${o.orderType.toLowerCase()}">${t[o.orderType]}</span>
            ${o.shopperFirstName ? `<span class="name">${esc(o.shopperFirstName)}</span>` : ''}
            <span class="status">${o.cancelled ? '' : t[o.preparationStatus as 'RECEIVED' | 'PREPARING']}</span>
          </div>
          <ul>${lines}</ul>
          ${action}
        </article>`;
      }).join('')
    : `<p class="empty">${t.empty}</p>`;
  $('#undo').innerHTML = [...pendingReady.keys()]
    .map((id) => cards.get(id))
    .filter((c) => c)
    .map((c) => `<button data-undo="${esc(c!.order.orderId)}">${t.undo} ${pickup(c!.order)}</button>`)
    .join('');
  tick();
}

function tick() {
  for (const el of document.querySelectorAll<HTMLElement>('[data-received]')) {
    const e = elapsed(el.dataset.received!);
    el.textContent = e.text;
    el.classList.toggle('overdue', e.overdue);
  }
}

document.addEventListener('click', (ev) => {
  const target = ev.target as HTMLElement;
  const adv = target.closest<HTMLElement>('[data-advance]');
  if (adv) return advance(adv.dataset.advance!);
  const und = target.closest<HTMLElement>('[data-undo]');
  if (und) return undo(und.dataset.undo!);
  const card = target.closest<HTMLElement>('.card');
  if (card) acknowledge(card.dataset.id!);
});

// ---- Chime (Web Audio, no asset) ----------------------------------------

const audio = new AudioContext();
function chime() {
  const now = audio.currentTime;
  [880, 1320].forEach((freq, i) => {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now + i * 0.18);
    gain.gain.exponentialRampToValueAtTime(0.6, now + i * 0.18 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.18 + 0.5);
    osc.connect(gain).connect(audio.destination);
    osc.start(now + i * 0.18);
    osc.stop(now + i * 0.18 + 0.55);
  });
}

// ---- Stream (fetch-based SSE so we can send the bearer token) -----------

$('#offline').textContent = t.offline;
const setOffline = (off: boolean) => $('#offline').classList.toggle('hidden', !off);

async function stream() {
  const ctrl = new AbortController();
  let idle = 0;
  const watchdog = () => {
    clearTimeout(idle);
    idle = window.setTimeout(() => ctrl.abort(), 60_000); // no data/heartbeat for 60 s: reconnect
  };
  const res = await api('/stream', { headers: { Accept: 'text/event-stream' }, signal: ctrl.signal });
  setOffline(false);
  watchdog();
  await resync();
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      watchdog();
      buf += value.replace(/\r\n?/g, '\n');
      let end: number;
      while ((end = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, end);
        buf = buf.slice(end + 2);
        let event = 'message';
        let data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).replace(/^ /, '');
        }
        if (!data || !event.startsWith('order.')) continue;
        const order: KitchenOrder = JSON.parse(data);
        if (event === 'order.cancelled') order.cancelled = true;
        handle(order.orderId, applyOrder(cards, order, opts(true)));
        render();
      }
    }
  } catch (err) {
    if (!ctrl.signal.aborted) throw err; // watchdog abort = clean reconnect
  } finally {
    clearTimeout(idle);
  }
}

async function connectLoop() {
  let delay = 1000;
  for (;;) {
    try {
      await stream();
      delay = 1000; // clean end: reconnect quickly
    } catch (err) {
      console.warn('stream error', err);
      setOffline(true);
      delay = Math.min(delay * 2, 30_000);
    }
    await new Promise((r) => setTimeout(r, delay));
  }
}

setInterval(tick, 1000);
// Day rollover: drop yesterday's cards.
setInterval(() => {
  const before = cards.size;
  for (const [id, c] of cards) if (!isToday(c.order.receivedAt, new Date())) cards.delete(id);
  if (cards.size !== before) render();
}, 60_000);

render();
connectLoop();
