import { applyOrder, reconcile, sorted, type Cards, type KitchenOrder, type Outcome } from './logic.js';

export type Filter = 'all' | 'RECEIVED' | 'PREPARING';
type Status = 'PREPARING' | 'READY';
export const UNDO_MS = 10_000;

/** Kitchen interaction state, independent of rendering and transport. */
export class Board {
  cards: Cards = new Map();
  focused: string | null = null;
  filter: Filter = 'all';
  online = false;
  loaded = false;
  lastSync: number | null = null;
  pending = new Map<string, number>();
  busy = new Set<string>();
  failures = new Map<string, Status>();
  reveal = false;

  constructor(public dismissed: Set<string>, private post: (id: string, status: Status) => Promise<unknown>,
    private notify: () => void = () => {}, private alert: (outcome: Outcome) => void = () => {}) {}

  get active() { return sorted(this.cards).filter(c => !this.pending.has(c.order.orderId)); }
  get queue() { return this.active.filter(c => c.order.cancelled || this.filter === 'all' || c.order.preparationStatus === this.filter); }

  ensureFocus() {
    if (this.focused && this.cards.has(this.focused) && !this.pending.has(this.focused)) return;
    this.focused = this.active.find(c => !c.order.cancelled)?.order.orderId ?? null;
    if (this.focused) {
      const c = this.cards.get(this.focused)!;
      c.isNew = false;
      if (this.filter !== 'all' && c.order.preparationStatus !== this.filter) this.filter = 'all';
      this.reveal = true;
    }
  }

  select(id: string) {
    const card = this.cards.get(id);
    if (!card || this.pending.has(id)) return;
    this.focused = id;
    card.isNew = false;
    this.notify();
  }

  private outcome(id: string, outcome: Outcome) {
    if (outcome === 'changed' || outcome === 'cancelled' || outcome === 'removed' || !this.cards.has(id)) {
      this.pending.delete(id);
      this.failures.delete(id);
    }
    if (outcome === 'new' || outcome === 'changed' || outcome === 'cancelled') this.alert(outcome);
  }

  receive(order: KitchenOrder, now = new Date()) {
    this.outcome(order.orderId, applyOrder(this.cards, order, { markNew: true, dismissed: this.dismissed, now }));
    this.lastSync = now.getTime();
    this.ensureFocus();
    this.notify();
  }

  sync(orders: KitchenOrder[], now = new Date()) {
    const outcomes = reconcile(this.cards, orders, { markNew: this.loaded, dismissed: this.dismissed, now });
    outcomes.forEach((o, i) => this.outcome(orders[i].orderId, o));
    for (const id of this.pending.keys()) if (!this.cards.has(id)) this.pending.delete(id);
    for (const id of this.failures.keys()) if (!this.cards.has(id)) this.failures.delete(id);
    this.loaded = true;
    this.lastSync = now.getTime();
    this.ensureFocus();
    this.notify();
  }

  acknowledge(id: string) {
    const c = this.cards.get(id);
    if (c && !c.order.cancelled) c.baseline = null;
    this.notify();
  }

  dismiss(id: string) {
    if (!this.cards.get(id)?.order.cancelled) return;
    this.cards.delete(id);
    this.dismissed.add(id);
    this.ensureFocus();
    this.notify();
  }

  canAdvance(id: string) {
    const c = this.cards.get(id);
    return !!c && this.online && !c.order.cancelled && !c.baseline && !this.busy.has(id) && !this.pending.has(id);
  }

  async advance(id: string, now = Date.now()) {
    if (!this.canAdvance(id) || this.failures.has(id)) return;
    if (this.cards.get(id)!.order.preparationStatus === 'RECEIVED') await this.send(id, 'PREPARING');
    else {
      this.pending.set(id, now + UNDO_MS);
      this.ensureFocus();
      this.notify();
    }
  }

  undo(id: string, now = Date.now()) {
    if ((this.pending.get(id) ?? 0) <= now || this.busy.has(id)) return;
    this.pending.delete(id);
    // Restoring an order must not change the new focus, even when it is empty.
    this.notify();
  }

  async flush(now = Date.now()) {
    await Promise.all([...this.pending].filter(([id, until]) => until <= now && !this.busy.has(id)).map(async ([id]) => {
      if (!this.online) {
        this.pending.delete(id);
        this.failures.set(id, 'READY');
        this.notify();
      } else await this.send(id, 'READY');
    }));
  }

  async retry(id: string) {
    const status = this.failures.get(id);
    if (status && this.canAdvance(id)) await this.send(id, status);
  }

  private async send(id: string, status: Status) {
    const c = this.cards.get(id);
    if (!c) return;
    this.busy.add(id);
    this.failures.delete(id);
    this.notify();
    // Incoming item changes/cancellation win over a late response to an action.
    const snapshot = c.order;
    try {
      await this.post(id, status);
      const current = this.cards.get(id);
      if (current && !current.order.cancelled && !current.baseline &&
          (current.order === snapshot || JSON.stringify(current.order.items) === JSON.stringify(snapshot.items))) {
        if (status === 'READY') this.cards.delete(id);
        else current.order = { ...current.order, preparationStatus: status };
      }
      this.lastSync = Date.now();
    } catch {
      const current = this.cards.get(id);
      if (current && !current.order.cancelled) this.failures.set(id, status);
    } finally {
      this.pending.delete(id);
      this.busy.delete(id);
      this.ensureFocus();
      this.notify();
    }
  }
}
