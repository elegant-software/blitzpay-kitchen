import { validateConnectionConfig, verifyKeycloak } from './connections.js';
import { createKitchenApi, type KitchenSession } from './kitchen-api.js';
import { stationPath, resolveStation, type Station } from './stations.js';
import Keycloak from '../../node_modules/keycloak-js/lib/keycloak.js';
import { applyOrder, diffItems, isToday, reconcile, sorted, type Cards, type KitchenOrder, type Outcome } from './logic.js';

interface Config {
  apiBaseUrl: string;
  branchId: string;
  stationId?: string;
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
      fatal(message: string): void;
    };
  }
}

const strings = {
  en: {
    PRE_ORDER: 'Pre-Order', WALK_IN_ORDERING: 'Walk-In', RECEIVED: 'Received', PREPARING: 'Preparing',
    toPreparing: 'Preparing', toReady: 'Station ready', cancelled: 'CANCELLED', tapToDismiss: 'Tap to dismiss',
    new: 'NEW', undo: 'Undo', offline: 'Offline – reconnecting…', empty: 'You\u2019re all caught up', emptyHint: 'New orders for this station will appear here automatically.', connecting: 'Connecting to kitchen\u2026', language: 'Language', station: 'Preparation station',
  },
  de: {
    PRE_ORDER: 'Vorbestellung', WALK_IN_ORDERING: 'Vor Ort', RECEIVED: 'Eingegangen', PREPARING: 'In Zubereitung',
    toPreparing: 'Zubereiten', toReady: 'Station fertig', cancelled: 'STORNIERT', tapToDismiss: 'Tippen zum Schließen',
    new: 'NEU', undo: 'Rückgängig', offline: 'Offline – verbinde neu…', empty: 'Keine offenen Bestellungen', emptyHint: 'Neue Bestellungen f\u00fcr diese Station erscheinen hier automatisch.', connecting: 'Verbindung zur K\u00fcche wird hergestellt\u2026', language: 'Sprache', station: 'Zubereitungsstation',
  },
};
const savedLanguage = localStorage.getItem('kitchen-language');
let language: 'en' | 'de' = savedLanguage === 'en' || savedLanguage === 'de'
  ? savedLanguage : navigator.language.toLowerCase().startsWith('de') ? 'de' : 'en';
let t = strings[language];
function translateShell() {
  document.documentElement.lang = language;
  document.querySelector('#language')!.setAttribute('aria-label', `${t.language}: ${language === 'de' ? 'Deutsch' : 'English'}`);
  document.querySelector('#language-menu')!.setAttribute('aria-label', t.language);
  document.querySelector('#language-code')!.textContent = language.toUpperCase();
  (document.querySelector('#language-flag') as HTMLImageElement).src = `flags/${language === 'de' ? 'de' : 'gb'}.svg`;
  document.querySelectorAll<HTMLElement>('[data-language]').forEach(button => button.setAttribute('aria-checked', String(button.dataset.language === language)));
  document.querySelector('.station-bar')!.setAttribute('aria-label', t.station);
  const connecting = document.querySelector('#connecting');
  if (connecting) connecting.textContent = t.connecting;
  document.querySelector('#offline')!.textContent = t.offline;
}
translateShell();

const UNDO_MS = 10_000;
const trigger = document.querySelector<HTMLButtonElement>('#language')!;
const menu = document.querySelector<HTMLElement>('#language-menu')!;
const choices = [...menu.querySelectorAll<HTMLButtonElement>('[data-language]')];
function closeLanguages(restoreFocus = false) {
  menu.hidden = true;
  trigger.setAttribute('aria-expanded', 'false');
  if (restoreFocus) trigger.focus();
}
function openLanguages() {
  menu.hidden = false;
  trigger.setAttribute('aria-expanded', 'true');
  choices.find(button => button.dataset.language === language)?.focus();
}
trigger.addEventListener('click', () => menu.hidden ? openLanguages() : closeLanguages());
trigger.addEventListener('keydown', event => {
  if (event.key === 'ArrowDown') { event.preventDefault(); openLanguages(); }
});
choices.forEach(button => button.addEventListener('click', () => {
  language = button.dataset.language === 'de' ? 'de' : 'en';
  t = strings[language];
  localStorage.setItem('kitchen-language', language);
  translateShell();
  if (started) render();
  closeLanguages(true);
}));
menu.addEventListener('keydown', event => {
  const index = choices.indexOf(document.activeElement as HTMLButtonElement);
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    choices[event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length]?.focus();
  } else if (event.key === 'Tab') closeLanguages();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !menu.hidden) { event.preventDefault(); closeLanguages(true); }
});
document.addEventListener('click', event => {
  if (!(event.target as HTMLElement).closest('.language-control')) closeLanguages();
});

// Any error before the first render (config, Keycloak init) goes to the error page instead of a black screen.
let started = false;
const fatal = (err: unknown) => { if (!started) window.kitchen.fatal(String((err as Error)?.message ?? err)); };
addEventListener('error', (e) => fatal(e.error ?? e.message));
addEventListener('unhandledrejection', (e) => fatal(e.reason));
const cfg = await window.kitchen.config();
validateConnectionConfig(cfg);
await verifyKeycloak(cfg);
const base = `${cfg.apiBaseUrl}/v1/merchant/branches/${encodeURIComponent(cfg.branchId)}/kitchen`;

// ---- Auth ---------------------------------------------------------------

async function setupAuth(): Promise<KitchenSession> {
  if (cfg.mockAuth) return { mock: true, headers: async () => ({}), login: async () => {} };
  const kc = new Keycloak({ url: cfg.keycloakUrl, realm: cfg.keycloakRealm, clientId: cfg.keycloakClientId });
  const redirectUri = location.origin + location.pathname;
  const save = () => window.kitchen.saveToken({ token: kc.token, refreshToken: kc.refreshToken });
  kc.onAuthSuccess = save;
  kc.onAuthRefreshSuccess = save;
  kc.onAuthRefreshError = () => {
    // Keycloak clears revoked refresh tokens; the request path starts a fresh login.
    if (!kc.refreshToken) void window.kitchen.saveToken(null);
  };
  kc.onTokenExpired = () => kc.updateToken(30).catch(() => {});
  const saved = await window.kitchen.loadToken();
  const common = { checkLoginIframe: false, pkceMethod: 'S256' as const, scope: 'openid offline_access', redirectUri };
  try {
    // With a saved token keycloak-js refreshes it; without one (or after the login redirect) it handles login.
    await kc.init(saved ? { ...common, ...saved } : { ...common, onLoad: 'login-required' });
  } catch (err) {
    console.error('Keycloak init failed', err instanceof Error ? err.stack : JSON.stringify(err));
    // A fresh login that fails would only loop back to the login page: show why instead.
    if (!saved) throw new Error(`Login failed. Check KEYCLOAK_CLIENT_ID, the client redirect URI, and that the kitchen account is enabled. ${err instanceof Error ? err.message : JSON.stringify(err)}`);
    if (!kc.refreshToken) {
      await window.kitchen.saveToken(null);
      await kc.login({ redirectUri, scope: 'openid offline_access' });
    }
    // Otherwise the network is down: keep the token, requests retry the refresh.
  }
  const login = async () => {
    await window.kitchen.saveToken(null);
    kc.clearToken();
    // prompt=login: Keycloak's own session cookie would otherwise sign the same rejected user straight back in.
    await kc.login({ redirectUri, scope: 'openid offline_access', prompt: 'login' });
  };
  return {
    mock: false,
    login,
    headers: async (forceRefresh) => {
      try { await kc.updateToken(forceRefresh ? -1 : 30); }
      catch (error) {
        if (!kc.refreshToken) await login();
        throw new Error(`Could not refresh the kitchen login at ${cfg.keycloakUrl}. Check the connection and sign in again.`);
      }
      if (!kc.token) {
        await login();
        throw new Error('The kitchen login is missing. Sign in again.');
      }
      return { Authorization: `Bearer ${kc.token}` };
    },
  };
}

const api = createKitchenApi(base, await setupAuth());

let stationId = cfg.stationId || '';
const ticketPath = (path: string) => stationPath(stationId, path);

// Logo is optional: missing, unset or failing → no watermark.
api('/branding').then((r) => r.json()).then(({ logoUrl }: { logoUrl: string | null }) => {
  if (!logoUrl) { console.warn('Kitchen branding: backend returned no merchant logo.'); return; }
  const img = document.getElementById('logo') as HTMLImageElement;
  img.onload = () => (img.hidden = false);
  img.onerror = () => { img.hidden = true; console.warn('Kitchen branding: merchant logo image failed to load. Check storage availability and the signed download URL.'); };
  img.src = logoUrl;
}).catch((error) => console.warn('Kitchen branding request failed:', error instanceof Error ? error.message : String(error)));

const postStatus = (orderId: string, status: 'PREPARING' | 'READY') =>
  api(ticketPath(`/orders/${encodeURIComponent(orderId)}/preparation-status`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });

// ---- State --------------------------------------------------------------

const cards: Cards = new Map();
const pendingReady = new Map<string, number>(); // orderId -> timeout handle
const flashing = new Set<string>();
const dismissKey = () => `dismissed:${cfg.apiBaseUrl}:${cfg.branchId}:${stationId}:${new Date().toDateString()}`;
const dismissed = new Set<string>(JSON.parse(localStorage.getItem(dismissKey()) ?? '[]'));
const opts = (markNew: boolean) => ({ markNew, dismissed, now: new Date() });

function handle(id: string, outcome: Outcome) {
  if (outcome === 'changed' && pendingReady.has(id)) {
    // Items changed during the undo window: don't send READY, bring the card back.
    clearTimeout(pendingReady.get(id));
    pendingReady.delete(id);
  }
  if (outcome === 'removed' || outcome === 'cancelled') {
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
  const orders: KitchenOrder[] = await (await api(ticketPath('/orders'))).json();
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
            ${o.tableName ? `<span class="table-name">${esc(o.tableName)}</span>` : ''}
            <span class="status">${o.cancelled ? '' : t[o.preparationStatus as 'RECEIVED' | 'PREPARING']}</span>
          </div>
          <ul>${lines}</ul>
          ${action}
        </article>`;
      }).join('')
    : `<section class="empty-state" role="status"><svg width="72" height="72" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 42h44M14 42a18 18 0 0 1 36 0M32 20v4M28 18h8M14 50h36"/><path d="m25 34 5 5 9-10"/></svg><h1>${t.empty}</h1><p>${t.emptyHint}</p></section>`;
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

const setOffline = (off: boolean, reason = '') => {
  $('#offline').textContent = reason ? `${t.offline} (${reason})` : t.offline;
  $('#offline').classList.toggle('hidden', !off);
};

async function stream() {
  const ctrl = new AbortController();
  let idle = 0;
  const watchdog = () => {
    clearTimeout(idle);
    idle = window.setTimeout(() => ctrl.abort(), 60_000); // no data/heartbeat for 60 s: reconnect
  };
  const res = await api(ticketPath('/stream'), { headers: { Accept: 'text/event-stream' }, signal: ctrl.signal });
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
      setOffline(true, (err as Error)?.message);
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

async function chooseStation() {
  const stations: Station[] = await (await api('/stations')).json();
  const chosen = resolveStation(stations, cfg.stationId || '');
  if (cfg.stationId && !chosen) throw new Error('Configured preparation station is not available in this branch. Check KITCHEN_STATION_ID.');
  if (!chosen) throw new Error('No preparation station is configured for this branch. Add a station in the merchant dashboard and check KITCHEN_BRANCH_ID.');
  stationId = chosen.id;
  $('#station-name').textContent = chosen.name;
  document.title = `${chosen.name} - BlitzPay Kitchen`;
  render();
  started = true;
  connectLoop();
}

await chooseStation();
