// Pure order-state logic: no DOM, no network. Tested by test/logic.test.mjs.

export type PreparationStatus = 'RECEIVED' | 'PREPARING' | 'READY';

export interface Item {
  itemId: string;
  name: string;
  quantity: number;
  locked: boolean;
}

export interface KitchenOrder {
  orderId: string;
  orderCode: string;
  pickupNumber: number | null;
  orderType: 'PRE_ORDER' | 'WALK_IN_ORDERING';
  shopperFirstName?: string;
  receivedAt: string;
  preparationStatus: PreparationStatus;
  cancelled: boolean;
  items: Item[];
}

export interface Card {
  order: KitchenOrder;
  /** Items as last acknowledged by staff; null = nothing unacknowledged. */
  baseline: Item[] | null;
  isNew: boolean;
}

export type Cards = Map<string, Card>;
export type Outcome = 'new' | 'changed' | 'cancelled' | 'removed' | 'none';

export interface Line {
  name: string;
  quantity: number;
  prevQuantity?: number;
  kind: 'same' | 'added' | 'changed' | 'removed';
  locked: boolean;
}

export const isToday = (iso: string, now: Date) => new Date(iso).toDateString() === now.toDateString();

const sameItems = (a: Item[], b: Item[]) =>
  a.length === b.length &&
  a.every((x, i) => x.itemId === b[i].itemId && x.name === b[i].name && x.quantity === b[i].quantity && x.locked === b[i].locked);

/** Current items annotated against the baseline; removed lines are appended at the end. */
export function diffItems(baseline: Item[] | null, current: Item[]): Line[] {
  if (!baseline) return current.map((i) => ({ name: i.name, quantity: i.quantity, kind: 'same', locked: i.locked }));
  const before = new Map(baseline.map((i) => [i.itemId, i]));
  const lines: Line[] = current.map((i) => {
    const prev = before.get(i.itemId);
    before.delete(i.itemId);
    if (!prev) return { name: i.name, quantity: i.quantity, kind: 'added', locked: i.locked };
    if (prev.quantity !== i.quantity || prev.name !== i.name || prev.locked !== i.locked)
      return { name: i.name, quantity: i.quantity, prevQuantity: prev.quantity, kind: 'changed', locked: i.locked };
    return { name: i.name, quantity: i.quantity, kind: 'same', locked: i.locked };
  });
  for (const r of before.values()) lines.push({ name: r.name, quantity: r.quantity, kind: 'removed', locked: r.locked });
  return lines;
}

/** Apply one incoming order (from the stream or a fetch) to the card map. */
export function applyOrder(cards: Cards, o: KitchenOrder, opts: { markNew: boolean; dismissed: Set<string>; now: Date }): Outcome {
  const id = o.orderId;
  const cur = cards.get(id);
  if (!isToday(o.receivedAt, opts.now)) {
    cards.delete(id);
    return 'none';
  }
  // Cancellation alerts survive snapshots/status updates until explicitly dismissed.
  if (cur?.order.cancelled) return 'none';
  if (o.cancelled) {
    if (opts.dismissed.has(id)) return 'none';
    const wasCancelled = cur?.order.cancelled;
    cards.set(id, { order: o, baseline: null, isNew: false });
    return wasCancelled ? 'none' : 'cancelled';
  }
  if (o.preparationStatus === 'READY') {
    if (!cur) return 'none';
    cards.delete(id);
    return 'removed';
  }
  if (!cur) {
    // An order coming back from READY: locked items were already made, everything else is new.
    const locked = o.items.filter((i) => i.locked);
    if (locked.length) {
      cards.set(id, { order: o, baseline: locked, isNew: false });
      return 'changed';
    }
    cards.set(id, { order: o, baseline: null, isNew: opts.markNew });
    return opts.markNew ? 'new' : 'none';
  }
  const changed = !sameItems(cur.order.items, o.items);
  if (changed) cur.baseline ??= cur.order.items;
  cur.order = o;
  return changed ? 'changed' : 'none';
}

/** Replace local state with the server's open-order list, keeping unacknowledged highlights and cancelled cards. */
export function reconcile(cards: Cards, fetched: KitchenOrder[], opts: { markNew: boolean; dismissed: Set<string>; now: Date }): Outcome[] {
  const ids = new Set(fetched.map((o) => o.orderId));
  for (const [id, c] of cards) {
    if ((!ids.has(id) && !c.order.cancelled) || !isToday(c.order.receivedAt, opts.now)) cards.delete(id);
  }
  return fetched.map((o) => applyOrder(cards, o, opts));
}

/** Open cards, oldest first. */
export const sorted = (cards: Cards) =>
  [...cards.values()].sort((a, b) => Date.parse(a.order.receivedAt) - Date.parse(b.order.receivedAt));
