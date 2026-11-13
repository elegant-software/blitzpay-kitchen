# Kitchen Screen login theme

Task: https://github.com/elegant-software/blitzpay-kitchen/issues/11

The Electron app continues to use its existing Keycloak Authorization Code + PKCE flow.
This directory supplies the **Keycloak server theme**, not an Electron password form.
No Angular project, password-handling IPC, or new authentication library is required.

The kitchen client gets Username, Password, Sign In, an accessible password visibility
toggle, and guidance to ask a manager for credentials. Registration, social sign-in,
password recovery and Remember me are omitted from the login template rather than hidden
after rendering. Offline login persistence remains managed by the existing Electron app.
English and German messages are included. The locale selector appears if the realm has
internationalization enabled with those supported languages.

## Install locally

Run these commands from the kitchen repository in PowerShell. The existing local
container is named `blitzpay-keycloak` and serves Keycloak at `http://127.0.0.1:8084`.

```powershell
docker cp ./keycloak/themes/blitzpay-kitchen blitzpay-keycloak:/opt/keycloak/themes/
docker restart blitzpay-keycloak
```

Restarting Keycloak briefly interrupts authentication for every local client.
Copying into a running container is for local development only: it is lost when the
container is recreated. To retain the theme, add this read-only volume to the existing
Keycloak Docker Compose service instead (resolve the source path relative to that
Compose file):

```yaml
volumes:
  - /absolute/path/to/blitzpay-kitchen/keycloak/themes/blitzpay-kitchen:/opt/keycloak/themes/blitzpay-kitchen:ro
```

Do not replace the existing database volumes, environment, ports or startup command.

Then, in the Keycloak Admin Console:

1. Select the realm used by the kitchen connection (default: `blitzpay`).
2. Open **Clients → blitzpay-kitchen → Settings → Login settings**.
3. Set **Login theme** to **blitzpay-kitchen** and save.
4. Keep the existing public-client, Standard flow, PKCE S256, redirect URIs and
   `offline_access` configuration.
5. Start a fresh interactive login in Electron. A screen with a valid saved offline token
   continues into the kitchen; it does not display a login page just because the theme changed.

The equivalent client representation field is
`attributes.login_theme = "blitzpay-kitchen"`. Merge this attribute into the existing
client; do not replace its other attributes or recreate the client.
Backend provisioning leaves an existing kitchen client unchanged.

Select the theme on the **client**, not Realm settings → Themes. Leave realm registration,
Google and password recovery settings as they are for other apps.
The realm must support username/password sign-in. This theme overrides the combined
`login.ftl` used by the standard browser flow; a custom identity-first or passwordless flow
requires separate template work and is not covered here.

If an old page is cached, restart the development Keycloak container and start a fresh
authorization request. During active theme development, Keycloak supports these startup
flags (restore caching in production):

```text
--spi-theme--static-max-age=-1 --spi-theme--cache-themes=false --spi-theme--cache-templates=false
```


The Username label does not change the realm's identity rules. In particular, Keycloak's
Email as username setting can replace a newly provisioned username with its email address.
Use the actual stored Kitchen Login identifier, and ensure backend provisioning and realm
configuration agree. Do not change a shared realm's identity rules just to install this theme.

## Production image

The backend platform Helm chart currently pins Keycloak 26.8.1. Build an image containing
the theme from this repository, publish it to your normal registry, then update the
platform's Keycloak image through its existing deployment process:

```powershell
docker build -f keycloak/Dockerfile -t blitzpay-keycloak-kitchen:26.8.1 keycloak
```

The Dockerfile extends the official pinned Keycloak image; it adds only the theme files.
Existing database configuration, secrets, TLS, runtime settings and realm data continue
to come from the platform deployment. Build/publish/deploy is a separate operational step;
packaging the Electron app alone does not install this server theme.

After rollout, select this theme on the kitchen client as above. For rollback, restore
that client's previous Login theme value (or clear it to inherit the realm theme), save,
and then restore the previous server image if needed.

## Verification

With Docker Desktop running, installed npm dependencies, and a graphical Electron host:

```powershell
npm run test:theme
```

This launches a disposable Keycloak **26.8.1** container on a random loopback port with a
generated temporary admin password and an isolated test realm. It does not connect to
or modify your existing Keycloak container. The test removes its own container when it
finishes. If the process is forcibly terminated, remove only the leftover container whose
name starts with `kitchen-theme-test-`.

It checks real FreeMarker rendering, invalid-password feedback, username retention,
Authorization Code + PKCE exchange, offline refresh, password reset, German copy, and a
control client that still shows Google, Register and Forgot Password. Hidden Electron
windows check keyboard order, show/hide password, 44px minimum touch targets and layouts
at 1280×900, 390×844 and 1024×600. Screenshots go to ignored `test-results/`.

You can test a different compatible server image using `KEYCLOAK_TEST_IMAGE`; review
template compatibility on every Keycloak upgrade. Inherited Keycloak templates continue
to handle required actions, session errors and other authentication pages.


### Recorded validation

Validated on 9 November 2026 with Keycloak 26.8.1 in an isolated Docker container and
Electron 45 on Windows. The real-auth integration and Electron layout checks above
passed, as did all 19 existing app tests. The Keycloak theme Docker image also built
successfully. These automated checks run against a disposable realm. Each target
environment requires theme installation and client selection as described above.

## Scope of the restriction

This theme changes the kitchen login UI. It does **not** prohibit direct registration,
password-reset or identity-provider URLs in a realm that permits them. Enforcing those
restrictions per client requires server-side authentication/registration policy.
The backend's branch permissions and manager-controlled Kitchen Login provisioning
continue to govern kitchen access.

References:
- [Keycloak theme development](https://www.keycloak.org/ui-customization/themes)
- [Keycloak 26.8.1 login template](https://github.com/keycloak/keycloak/blob/26.8.1/themes/src/main/resources/theme/base/login/login.ftl)
