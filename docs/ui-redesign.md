# Kitchen UI redesign

## Agreed direction

- Prioritize fast reading and actions during busy kitchen service.
- Keep a dark theme with charcoal surfaces and consistent blue, green, and amber status colors.
- Give the focused order a large panel on the right.
- Keep other orders visible in a compact, selectable queue on the left, with pickup number, age, status, and an item summary.
- Distinguish New and Preparing orders and show their counts; keep the oldest orders first.
- Staff select orders manually. New arrivals do not replace the focused order.
- After staff mark the focused order Ready, select the oldest waiting order.
- Make item quantities, overdue indicators, and preparation actions prominent.
- Optimize for a landscape touchscreen used at arm's length, with large tap targets and readable quantities. Keep preparation actions visible.
- Changes to another order do not interrupt the focused order. Keep a persistent Changed indicator until staff explicitly acknowledge the changes.
- Selecting an order shows its item differences without acknowledging them. Provide a separate Acknowledge changes action.
- Keep cancelled orders visible until explicitly dismissed. Show a prominent cancellation alert in the queue and detail panel, disable preparation actions, and preserve the focused order.
- Let the queue scroll independently with persistent All / New / Preparing filters and counts. Default to All and oldest first; filtering preserves the focused order.
- Let long item lists scroll independently while keeping the pickup number, elapsed time, and preparation action visible.
- Mark ready immediately advances focus and offers a clearly labelled 10-second Undo countdown. Undo restores the order without interrupting the newly focused order.
- On reopened orders, separate Items to prepare from Already prepared, emphasizing additional work while retaining previously prepared items below it.
- During connection loss, keep existing orders visible, show an offline banner and last successful sync time, and disable preparation actions until reconnection. Failed updates retain the order with an explicit retry action.
- New, changed, and cancelled orders produce short sounds and persistent visual indicators. Provide an accessible mute control; avoid repeated flashing and retain visual alerts while muted.
- Keep the existing language behavior. Do not add a language switcher.
- Require explicit acknowledgement of changed items before enabling the order's preparation action. Selecting an order never clears its changes.
- New means orders that have not started preparation. Use a separate Unseen marker for arrivals staff have not opened.
- Unacknowledged cancellations remain visible under every queue filter.
- At startup and after completion, dismissal, or removal of the focused order, select the oldest New or Preparing order across all filters and reveal its queue entry. Show an empty detail panel when none remain. Other arrivals and updates preserve focus.
- Start preparing takes effect with one tap, without confirmation or Undo. Mark ready retains its 10-second Undo.

## Target and review status

- Exact physical screen size is unspecified; use the current nominal 1600 x 900 window as the initial layout reference for the agreed landscape touchscreen target.
- Implemented for issue #1 following authorization to proceed. The supplied logo lives in renderer/assets/bona-me-logo.png and is bundled by the existing renderer/** packaging rule. Warm gold branding complements the agreed charcoal surfaces and blue/green/amber status colors; no remote fonts or assets are required.

- Browser language still selects German or English automatically. There is no language switcher.
- `npm test` covers order reconciliation and board interactions. `npm run test:ui` runs a hidden Electron window at 1600 x 900 with 30 orders and a 40-item list, exercising scrolling, focus preservation, change acknowledgement, cancellation dismissal, failure/retry, Ready Undo, reopened work, offline/reconnection, and mute. It saves a screenshot to the system temporary directory. Set `UI_TEST_LANG=de-DE` to check German.
- Ready advances focus immediately but sends the server update after the 10-second Undo window. A change or cancellation during that window cancels the pending update. Failed updates remain visible and require explicit retry; no preparation update is sent while offline.
