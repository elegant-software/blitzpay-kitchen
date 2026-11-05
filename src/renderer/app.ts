import Keycloak from '../../node_modules/keycloak-js/lib/keycloak.js';
import { diffItems, isToday, type KitchenOrder, type Line } from './logic.js';
import { Board, type Filter } from './board.js';

interface Config {
  apiBaseUrl: string; branchId: string; keycloakUrl: string; keycloakRealm: string;
  keycloakClientId: string; overdueMinutes: number; mockAuth: boolean;
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
    kitchen: 'Kitchen', queue: 'Order queue', focused: 'Focused order', filters: 'Order filters', all: 'All',
    RECEIVED: 'New', PREPARING: 'Preparing', PRE_ORDER: 'Pre-order', WALK_IN_ORDERING: 'Walk-in',
    start: 'Start preparing', ready: 'Mark ready', cancelled: 'CANCELLED', dismiss: 'Dismiss cancellation',
    cancellation: 'Do not prepare this order. Dismiss after reviewing the cancellation.',
    unseen: 'Unseen', changed: 'Changed', acknowledge: 'Acknowledge changes',
    review: 'Review the highlighted item changes before continuing.',
    undo: 'Undo ready', empty: 'No open orders', emptyHint: 'Orders will appear here as they arrive.',
    noMatches: 'No orders in this filter', select: 'Select an order from the queue',
    prepare: 'Items to prepare', prepared: 'Already prepared', added: 'Added', removed: 'Removed', updated: 'Updated',
    overdue: 'Overdue', online: 'Live', offline: 'Offline — reconnecting…', lastSync: 'Last successful sync', never: 'Not yet synced',
    mute: 'Mute alerts', unmute: 'Unmute alerts', retry: 'Retry update', failed: 'Update failed. The order has been retained.',
    lightTheme: 'Switch to light theme', darkTheme: 'Switch to dark theme',
    saving: 'Saving…', seconds: 's', readySent: 'Sending ready…', readyPending: 'Ready', wait: 'Reconnect to update orders',
  },
  de: {
    kitchen: 'Küche', queue: 'Bestellungen', focused: 'Ausgewählte Bestellung', filters: 'Bestellfilter', all: 'Alle',
    RECEIVED: 'Neu', PREPARING: 'In Zubereitung', PRE_ORDER: 'Vorbestellung', WALK_IN_ORDERING: 'Vor Ort',
    start: 'Zubereiten', ready: 'Fertig melden', cancelled: 'STORNIERT', dismiss: 'Stornierung schließen',
    cancellation: 'Diese Bestellung nicht zubereiten. Nach Prüfung die Stornierung schließen.',
    unseen: 'Ungesehen', changed: 'Geändert', acknowledge: 'Änderungen bestätigen',
    review: 'Die markierten Änderungen vor dem Fortfahren prüfen.',
    undo: 'Fertig rückgängig', empty: 'Keine offenen Bestellungen', emptyHint: 'Neue Bestellungen erscheinen hier automatisch.',
    noMatches: 'Keine Bestellungen in diesem Filter', select: 'Eine Bestellung aus der Liste auswählen',
    prepare: 'Zuzubereiten', prepared: 'Bereits zubereitet', added: 'Hinzugefügt', removed: 'Entfernt', updated: 'Geändert',
    overdue: 'Überfällig', online: 'Verbunden', offline: 'Offline — verbinde neu…', lastSync: 'Letzte erfolgreiche Synchronisierung', never: 'Noch nicht synchronisiert',
    mute: 'Hinweistöne aus', unmute: 'Hinweistöne an', retry: 'Erneut versuchen', failed: 'Aktualisierung fehlgeschlagen. Die Bestellung bleibt erhalten.',
    lightTheme: 'Helles Design aktivieren', darkTheme: 'Dunkles Design aktivieren',
    saving: 'Wird gespeichert…', seconds: 's', readySent: 'Fertig wird gesendet…', readyPending: 'Fertig', wait: 'Zum Aktualisieren Verbindung herstellen',
  },
};
const t = navigator.language.toLowerCase().startsWith('de') ? strings.de : strings.en;
document.documentElement.lang = t === strings.de ? 'de' : 'en';
let theme = localStorage.getItem('theme') === 'light' ? 'light' : 'dark';
document.documentElement.dataset.theme = theme;
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
  const res = await fetch(base + path, { ...init, signal: init.signal ?? AbortSignal.timeout(15_000), headers: { ...(await authHeaders()), ...init.headers } });
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${res.status}`);
  return res;
}

const postStatus = (orderId: string, status: 'PREPARING' | 'READY') =>
  api(`/orders/${encodeURIComponent(orderId)}/preparation-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });


const $ = (sel: string) => document.querySelector<HTMLElement>(sel)!;
const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const pickup = (o: KitchenOrder) => o.pickupNumber == null ? o.orderCode : `#${String(o.pickupNumber).padStart(3, '0')}`;
const dismissKey = () => `dismissed:${new Date().toDateString()}`;
function savedDismissals(): string[] {
  try { const v = JSON.parse(localStorage.getItem(dismissKey()) ?? '[]'); return Array.isArray(v) ? v : []; }
  catch { return []; }
}
let muted = localStorage.getItem('muted') === 'true';
const icons = {
  sound: '<path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  muted: '<path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="m16 9 6 6m0-6-6 6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  moon: '<path d="M20.5 13a8.5 8.5 0 0 1-9.5-9.5A8.5 8.5 0 1 0 20.5 13Z"/>',
};
function iconButton(selector: string, icon: keyof typeof icons, label: string) {
  const button = $(selector);
  button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${icons[icon]}</svg>`;
  button.setAttribute('aria-label', label);
  button.title = label;
}
let audio: AudioContext | undefined;
function chime() {
  if (muted) return;
  try {
    audio ??= new AudioContext();
    void audio.resume().catch(() => {});
    const now = audio.currentTime;
    [880, 1320].forEach((freq, i) => {
      const osc = audio!.createOscillator();
      const gain = audio!.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + i * .12);
      gain.gain.exponentialRampToValueAtTime(.18, now + i * .12 + .01);
      gain.gain.exponentialRampToValueAtTime(.0001, now + i * .12 + .18);
      osc.connect(gain).connect(audio!.destination);
      osc.start(now + i * .12); osc.stop(now + i * .12 + .2);
    });
  } catch { /* Visual alerts work even if audio is unavailable. */ }
}
const board = new Board(new Set(savedDismissals()), postStatus, render, outcome => {
  chime();
  $('#announcements').textContent = outcome === 'changed' ? t.changed : outcome === 'cancelled' ? t.cancelled : t.unseen;
});
$('#screen-label').textContent = t.kitchen;
$('#queue-title').textContent = t.queue;
$('#filters').setAttribute('aria-label', t.filters);
$('#detail').setAttribute('aria-label', t.focused);

function badges(c: NonNullable<ReturnType<typeof board.cards.get>>) {
  return `${c.order.cancelled ? `<span class="badge cancelled">${t.cancelled}</span>` : `<span class="badge ${c.order.preparationStatus.toLowerCase()}">${t[c.order.preparationStatus as 'RECEIVED' | 'PREPARING']}</span>`}
    ${c.baseline ? `<span class="badge changed">${t.changed}</span>` : ''}
    ${c.isNew ? `<span class="badge unseen">${t.unseen}</span>` : ''}
    ${board.failures.has(c.order.orderId) ? `<span class="badge changed">${t.retry}</span>` : ''}`;
}
function lineHTML(l: Line) {
  const tag = l.kind === 'same' ? '' : `<span class="diff-label">${l.kind === 'added' ? t.added : l.kind === 'removed' ? t.removed : t.updated}</span>`;
  return `<li class="item ${l.kind}"><span class="qty">${l.prevQuantity !== undefined && l.prevQuantity !== l.quantity ? `<s>${l.prevQuantity}×</s>` : ''}${l.quantity}×</span><span class="item-name">${esc(l.name)} ${tag}</span></li>`;
}
function timer(o: KitchenOrder) { return `<span class="timer" data-received="${esc(o.receivedAt)}"></span>`; }

function render() {
  // Keep scroll positions and keyboard focus through background stream updates.
  const scroll = $('#queue').scrollTop;
  const itemsScroll = document.querySelector('.items-scroll')?.scrollTop ?? 0;
  const previousDetail = $('#detail').dataset.order;
  const focusedButton = document.activeElement as HTMLElement | null;
  const focusKey = focusedButton?.dataset.key;
  const counts = board.active;
  $('#queue-count').textContent = String(counts.length);
  $('#filters').innerHTML = (['all', 'RECEIVED', 'PREPARING'] as Filter[]).map(f =>
    `<button type="button" data-filter="${f}" data-key="filter-${f}" aria-pressed="${board.filter === f}">${f === 'all' ? t.all : t[f]} <span>${counts.filter(c => f === 'all' || c.order.preparationStatus === f || c.order.cancelled).length}</span></button>`).join('');
  $('#queue').innerHTML = board.queue.length ? board.queue.map(c => {
    const o = c.order;
    const summary = o.items.filter(i => !i.locked).map(i => `${i.quantity}× ${i.name}`).join(' · ');
    return `<button type="button" class="queue-entry ${o.cancelled ? 'is-cancelled' : ''} ${board.focused === o.orderId ? 'selected' : ''}" data-select="${esc(o.orderId)}" data-key="order-${esc(o.orderId)}" aria-pressed="${board.focused === o.orderId}">
      <span class="entry-top"><strong class="pickup">${esc(pickup(o))}</strong>${timer(o)}</span>
      <span class="badges">${badges(c)}</span><span class="summary">${esc(summary || t.prepared)}</span></button>`;
  }).join('') : `<div class="queue-empty">${board.active.length ? t.noMatches : t.empty}</div>`;
  $('#queue').scrollTop = scroll;
  const c = board.focused ? board.cards.get(board.focused) : undefined;
  $('#detail').dataset.order = board.focused ?? '';
  if (!c) {
    $('#detail').innerHTML = `<div class="empty-detail"><span class="empty-mark">✓</span><h2>${t.empty}</h2><p>${board.active.length ? t.select : t.emptyHint}</p></div>`;
  } else {
    const o = c.order, id = esc(o.orderId);
    const lines = diffItems(c.baseline, o.items);
    const work = lines.filter(l => !l.locked), prepared = lines.filter(l => l.locked);
    const disabled = !board.canAdvance(o.orderId) || board.failures.has(o.orderId);
    $('#detail').innerHTML = `<header class="detail-header"><div><span class="eyebrow">${t.focused}</span><div class="detail-number">${esc(pickup(o))}</div></div><div class="detail-time">${timer(o)}</div>
      <div class="detail-meta"><span class="badge type">${t[o.orderType]}</span>${o.shopperFirstName ? `<span>${esc(o.shopperFirstName)}</span>` : ''}<span class="badges">${badges(c)}</span></div></header>
      ${o.cancelled ? `<div class="alert cancellation" role="alert"><strong>${t.cancelled}</strong><span>${t.cancellation}</span></div>` : c.baseline ? `<div class="alert change-alert"><strong>${t.changed}</strong><span>${t.review}</span></div>` : ''}
      <div class="items-scroll"><h2>${t.prepare} <span>${o.items.filter(i => !i.locked).reduce((n, i) => n + i.quantity, 0)}</span></h2><ul>${work.map(lineHTML).join('')}</ul>
      ${prepared.length ? `<section class="prepared"><h2>${t.prepared}</h2><ul>${prepared.map(lineHTML).join('')}</ul></section>` : ''}</div>
      <footer class="detail-actions">
      ${board.failures.has(o.orderId) ? `<div class="failure" role="alert">${t.failed}<button type="button" data-retry="${id}" data-key="retry-${id}" ${board.canAdvance(o.orderId) ? '' : 'disabled'}>${t.retry}</button></div>` : ''}
      ${!board.online && !o.cancelled ? `<p class="action-hint">${t.wait}</p>` : ''}
      ${o.cancelled ? `<button type="button" class="action dismiss" data-dismiss="${id}" data-key="dismiss-${id}">${t.dismiss}</button>` : `${c.baseline ? `<button type="button" class="acknowledge" data-ack="${id}" data-key="ack-${id}">${t.acknowledge}</button>` : ''}<button type="button" class="action ${o.preparationStatus === 'PREPARING' ? 'ready' : ''}" data-advance="${id}" data-key="advance-${id}" ${disabled ? 'disabled' : ''}>${board.busy.has(o.orderId) ? t.saving : o.preparationStatus === 'RECEIVED' ? t.start : t.ready}<span aria-hidden="true"> →</span></button>`}</footer>`;
    const scroller = document.querySelector('.items-scroll');
    if (scroller && previousDetail === o.orderId) scroller.scrollTop = itemsScroll;
  }
  // Do not rewrite Undo every second: timers update in place without live-region chatter.
  const undoHTML = [...board.pending.keys()].map(id => {
    const o = board.cards.get(id)?.order;
    return o ? `<div class="undo-notice"><span>${t.readyPending} <strong>${esc(pickup(o))}</strong></span><button type="button" data-undo="${esc(id)}" data-key="undo-${esc(id)}">${t.undo} <span data-countdown="${esc(id)}"></span></button></div>` : '';
  }).join('');
  if ($('#undo').innerHTML !== undoHTML && [...$('#undo').querySelectorAll('[data-undo]')].map(e => (e as HTMLElement).dataset.undo).join('|') !== [...board.pending.keys()].join('|')) $('#undo').innerHTML = undoHTML;
  $('#undo').classList.toggle('hidden', !board.pending.size);
  document.body.classList.toggle('has-undo', !!board.pending.size);
  iconButton('#mute', muted ? 'muted' : 'sound', muted ? t.unmute : t.mute);
  $('#mute').setAttribute('aria-pressed', String(muted));
  iconButton('#theme', theme === 'dark' ? 'sun' : 'moon', theme === 'dark' ? t.lightTheme : t.darkTheme);
  $('#connection').textContent = board.online ? t.online : t.offline;
  $('#connection').classList.toggle('connected', board.online);
  $('#offline').classList.toggle('hidden', board.online);
  $('#offline').textContent = `${t.offline} · ${t.lastSync}: ${board.lastSync ? new Date(board.lastSync).toLocaleTimeString() : t.never}`;
  if (focusKey) [...document.querySelectorAll<HTMLElement>('[data-key]')].find(e => e.dataset.key === focusKey)?.focus({ preventScroll: true });
  if (board.reveal) {
    [...document.querySelectorAll<HTMLElement>('[data-select]')].find(e => e.dataset.select === board.focused)?.scrollIntoView({ block: 'nearest' });
    board.reveal = false;
  }
  tick();
}

function tick() {
  for (const el of document.querySelectorAll<HTMLElement>('[data-received]')) {
    const s = Math.max(0, Math.floor((Date.now() - Date.parse(el.dataset.received!)) / 1000));
    const overdue = s >= cfg.overdueMinutes * 60;
    el.textContent = `${overdue ? `${t.overdue} · ` : ''}${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    el.classList.toggle('overdue', overdue);
  }
  for (const el of document.querySelectorAll<HTMLElement>('[data-countdown]')) {
    const seconds = Math.max(0, Math.ceil(((board.pending.get(el.dataset.countdown!) ?? 0) - Date.now()) / 1000));
    el.textContent = seconds ? `(${seconds}${t.seconds})` : t.readySent;
    (el.closest('button') as HTMLButtonElement).disabled = seconds === 0;
  }
}

document.addEventListener('click', ev => {
  const button = (ev.target as HTMLElement).closest<HTMLButtonElement>('button');
  if (!button || button.disabled) return;
  void audio?.resume().catch(() => {});
  const d = button.dataset;
  if (button.id === 'mute') { muted = !muted; localStorage.setItem('muted', String(muted)); render(); }
  else if (button.id === 'theme') {
    theme = theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('theme', theme);
    document.documentElement.dataset.theme = theme;
    render();
  }
  else if (d.filter) { board.filter = d.filter as Filter; render(); }
  else if (d.select) board.select(d.select);
  else if (d.advance) void board.advance(d.advance);
  else if (d.ack) board.acknowledge(d.ack);
  else if (d.dismiss) { board.dismiss(d.dismiss); localStorage.setItem(dismissKey(), JSON.stringify([...board.dismissed])); }
  else if (d.undo) board.undo(d.undo);
  else if (d.retry) void board.retry(d.retry);
});

const setOffline = (off: boolean) => { board.online = !off; render(); };
async function resync() {
  const orders: KitchenOrder[] = await (await api('/orders')).json();
  board.sync(orders);
}

// Read the SSE stream before the snapshot: replay buffered events after reconciliation.
async function stream() {
  const ctrl = new AbortController();
  let idle: ReturnType<typeof setTimeout> | undefined;
  const watchdog = () => { clearTimeout(idle); idle = setTimeout(() => ctrl.abort(), 60_000); };
  watchdog();
  let reader: ReadableStreamDefaultReader<string> | undefined;
  try {
    const res = await api('/stream', { headers: { Accept: 'text/event-stream' }, signal: ctrl.signal });
    reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    await resync();
    setOffline(false);
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      watchdog();
      buf += value;
      // Normalize after buffering so a CRLF split across chunks stays intact.
      buf = buf.replace(/\r\n/g, '\n');
      let end: number;
      while ((end = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, end); buf = buf.slice(end + 2);
        let event = 'message'; const data: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (!data.length || !event.startsWith('order.')) continue;
        const order: KitchenOrder = JSON.parse(data.join('\n'));
        if (event === 'order.cancelled') order.cancelled = true;
        board.receive(order);
      }
    }
  } finally {
    clearTimeout(idle); ctrl.abort();
    await reader?.cancel().catch(() => {});
    setOffline(true);
  }
}
async function connectLoop() {
  let delay = 1000;
  for (;;) {
    try { await stream(); delay = 1000; }
    catch (err) { console.warn('stream error', err); delay = Math.min(delay * 2, 30_000); }
    await new Promise(r => setTimeout(r, delay));
  }
}
setInterval(() => { tick(); void board.flush(); }, 250);
setInterval(() => {
  let changed = false;
  for (const [id, c] of board.cards) if (!isToday(c.order.receivedAt, new Date())) {
    board.cards.delete(id); board.pending.delete(id); board.failures.delete(id); changed = true;
  }
  if (changed) { board.ensureFocus(); render(); }
}, 60_000);
render();
void connectLoop();
