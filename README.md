# BlitzPay Kitchen Screen

Electron kiosk that shows one Branch's open Orders live and lets kitchen staff advance their
Preparation Status (`RECEIVED → PREPARING → READY`) with one tap per step.

- Tracking issue: [elegant-software/zack-pay#181](https://github.com/elegant-software/zack-pay/issues/181)
- Platform decision: [ADR-0022](https://github.com/elegant-software/zack-pay/blob/main/docs/adr/0022-kitchen-screen-electron-kiosk.md) (`blitz-pay/docs/adr/0022-kitchen-screen-electron-kiosk.md`)

## Related repos

| Repo | Role |
|---|---|
| [`zack-pay`](https://github.com/elegant-software/zack-pay) (local: `blitz-pay`) | Backend (Kotlin/Spring). Owns Orders, Preparation Status, Pickup Number, the kitchen API used here, and the READY push. Kitchen backend: [PR #182](https://github.com/elegant-software/zack-pay/pull/182) |
| [`blitz-pay-react-native`](https://github.com/elegant-software/blitz-pay-react-native) (local: `blitz-pay-prototype`) | Shopper and merchant apps. They create the Orders this screen shows and display their Preparation Status |
| [`blitzpay-admin-dashboard`](https://github.com/elegant-software/blitzpay-admin-dashboard) | Admin dashboard for merchants and branches (the `branchId` this screen is bound to) |

## Run locally against the real backend

1. Start the backend from `blitz-pay` (with the PR #182 changes): set the env vars listed in its `README.md`/`CLAUDE.md`, then `./gradlew bootRun`. It listens on `http://localhost:8080` by default (Spring default). That is also the default `keycloakUrl` here, so if both run locally, move one of them (e.g. `SERVER_PORT=8081 ./gradlew bootRun`) and point `KITCHEN_API_URL` at it.
2. Set up the Keycloak kitchen client as described under [Config](#config). The kitchen user must be in the Branch's `branch_<branchId>` group, otherwise the API returns 403.
3. Run the screen:

```sh
npm install
KITCHEN_API_URL=http://localhost:8080 KITCHEN_BRANCH_ID=<branch-uuid> \
KEYCLOAK_URL=<keycloak-url> KEYCLOAK_REALM=<realm> KIOSK=0 npm start
```

4. Place an order for that Branch from the shopper or merchant app. A card shows up with a chime.

## Run locally against the mock

```sh
npm install
npm run mock                       # mock API on http://localhost:8787, random event every 15 s
MOCK_AUTH=1 KIOSK=0 npm start      # skip Keycloak, windowed instead of kiosk
```

Trigger events by hand: `curl -X POST localhost:8787/mock/created` (also `changed`, `cancelled`,
`reopen` = item added to a READY order). Mock env: `PORT`, `EVENT_SECONDS`.

## Config

Read in this order, later wins: bundled `config.json` → `<userData>/config.json` → environment. Environment variables can also go in a `.env` file next to `package.json` (gitignored); real environment variables win over it.

If the screen cannot start (server unreachable, login failing) it shows the reason and retries every 10 s. The log is in `<userData>/kitchen.log`.

| key | env | default |
|---|---|---|
| `apiBaseUrl` | `KITCHEN_API_URL` | `http://localhost:8787` |
| `branchId` | `KITCHEN_BRANCH_ID` | `demo-branch` |
| `keycloakUrl` | `KEYCLOAK_URL` | `http://localhost:8080` |
| `keycloakRealm` | `KEYCLOAK_REALM` | `blitzpay` |
| `keycloakClientId` | `KEYCLOAK_CLIENT_ID` | `blitzpay-kitchen` |
| `overdueMinutes` | `OVERDUE_MINUTES` | `15` (timer turns red) |
| `mockAuth` | `MOCK_AUTH=1` | off |
| – | `KIOSK=0` | kiosk on |

`<userData>` is e.g. `~/Library/Application Support/blitzpay-kitchen` (macOS),
`%APPDATA%\blitzpay-kitchen` (Windows), `~/.config/blitzpay-kitchen` (Linux).

Keycloak client (public, PKCE): valid redirect URI `app://kitchen/renderer/index.html`,
web origin `app://kitchen`, `offline_access` scope allowed. The backend must allow CORS from origin
`app://kitchen`. The refresh (offline) token is stored encrypted with Electron `safeStorage` in
`<userData>/token.bin`; delete it to force a new login.

## API used

- `GET  /v1/merchant/branches/{branchId}/kitchen/orders` – open orders (cancelled ones included; dismissal is tracked on the screen)
- `GET  /v1/merchant/branches/{branchId}/kitchen/stream` – SSE: `order.created`, `order.changed`, `order.cancelled`
- `POST /v1/merchant/branches/{branchId}/kitchen/orders/{orderId}/preparation-status` – `{ "status": "PREPARING" | "READY" }`

The stream reconnects if nothing (not even a `:` heartbeat comment) arrives for 60 s.

## Build, test, package

```sh
npm run build      # tsc → dist/
npm test           # node:test on the order diff/reconcile logic (src/renderer/logic.ts)
npm run package    # electron-builder for the current OS → release/
npx electron-builder --win --linux   # cross-build (macOS dmg must be built on macOS)
```

Packaged builds register themselves to start at login (Windows/macOS login item, Linux XDG autostart).

## CI/CD

Same flow as the other BlitzPay repos, using the shared workflows in [`elegant-ci-cd-pipeline`](https://github.com/elegant-software/elegant-ci-cd-pipeline):

| Workflow | Trigger | What |
|---|---|---|
| `ci-build.yml` | PR / push to `main` | Typecheck + tests via shared `frontend-npm-test.yml` (JUnit check + summary) |
| `pr-auto-label.yml` | PR | Labels from `.github/labels.yml`, which drive the version bump |
| `release-notes.yml` | PR merged | Updates the draft release notes |
| `release-manual.yml` | Manual ("Release · Create Release") | Tags and publishes the next version from commits |
| `cd-release.yml` | Release published | Checks CI passed, builds the Windows `.exe`, Linux `.AppImage` and macOS `.dmg`, and attaches them to the release |
| `cleanup-*.yml` | Nightly (dry run) / manual | Prunes old releases, tags and workflow runs |

Repo secret needed: `RELEASE_PUBLISH_TOKEN` (same as other repos). Installers are not code-signed yet, so Windows SmartScreen and macOS Gatekeeper will warn on first launch.
