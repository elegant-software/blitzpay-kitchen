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
| `keycloakRealm` | `KEYCLOAK_REALM` | `blitzpay-business` |
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


## Food Kitchen and Drinks Bar (issue #199)

Update/restart the backend first so its station-ticket migration and endpoints are available.
Configure the branch stations and category defaults/product overrides in the admin dashboard.
Newly submitted items retain that routing even if the catalog is changed later. Existing orders
and unmapped products stay in the visible **Unassigned / General kitchen** queue.

There is no station picker. A screen shows the station pinned with `KITCHEN_STATION_ID`
(`stationId` in config.json), otherwise the branch's default station: the first configured one,
which also receives items without a category or product assignment. Each screen receives only its station items; both keep the customer order number and table.
The Ready action completes only the screen's station. Customer readiness waits for all stations.
No additional Keycloak client or station user is required.

On two separate devices, run `npm.cmd start` on each; pin the non-default one (e.g. Drinks Bar).
For two windows on the same Windows computer, use two PowerShell terminals in this repo,
with the same backend/branch/Keycloak settings (from your existing `.env` or environment).

First terminal:

```powershell
$env:KITCHEN_PROFILE = 'food'
$env:MOCK_AUTH = '0'
$env:KIOSK = '0'
npm.cmd start
```

Second terminal:

```powershell
$env:KITCHEN_PROFILE = 'drinks'
$env:KITCHEN_STATION_ID = '<drinks-station-uuid>'
$env:MOCK_AUTH = '0'
$env:KIOSK = '0'
npm.cmd start
```

Move each window to its monitor. Profiles isolate the single-instance lock, tokens and
cancellation dismissals. They inherit common server configuration;
optional profile-specific config lives under `<userData>/profiles/<profile>/config.json`.
`KITCHEN_PROFILE` accepts letters, digits, underscores and hyphens only.

The backend validates the station against the authenticated branch. A bad pinned station is shown
as a startup error, never replaced with another branch or a branch-wide queue.

Station API paths (under `/v1/merchant/branches/{branchId}/kitchen`):

- `GET /stations`
- `GET /stations/{stationId}/orders`
- `GET /stations/{stationId}/stream`
- `POST /stations/{stationId}/orders/{orderId}/preparation-status`

The mock supports Food Kitchen and Drinks Bar and seeds order #42 with two burgers and two colas
at Table 7. `npm test` includes a two-station HTTP/reconnect smoke test.

`npm run test:ui` runs two hidden Electron renderers against the mock and verifies that completing drinks leaves food visible.


### Startup connection checks

The bundled demo connection is for the mock. Real screens need `KITCHEN_API_URL`,
`KITCHEN_BRANCH_ID`, `KEYCLOAK_URL`, `KEYCLOAK_REALM`, and `KEYCLOAK_CLIENT_ID`
in the gitignored `.env`, their environment, or user config. Real environment variables take
precedence over `.env`; clear old terminal overrides if they point at a different server.
Both station profiles share `.env`. Use `MOCK_AUTH=1` only with the development mock.

Startup validates the real branch setting and Keycloak realm discovery before navigating to
login. An unreachable API names the failed service/address; a connecting message appears while
startup is pending. If the backend was updated, restart it to apply station-ticket migrations
before restarting the screens.

A real API 401 triggers one forced token refresh. If it still rejects the session, the screen clears its saved session and starts login again. Mock-mode 401s explicitly identify `MOCK_AUTH=0` as the required real-server setting. Startup logs include the profile and authentication mode, never tokens.
