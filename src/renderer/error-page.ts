const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Full-screen error shown instead of a black window when the screen cannot start.
export function errorPage(title: string, detail: string, retrySeconds: number) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body { margin: 0; height: 100vh; display: flex; align-items: center; justify-content: center; background: #111; color: #eee; font: 24px system-ui, sans-serif; text-align: center; }
h1 { color: #f55; font-size: 40px; } code { color: #aaa; word-break: break-all; }
</style></head><body><div>
<h1>Kitchen Screen can't start</h1>
<p>${esc(title)}</p>
<p><code>${esc(detail)}</code></p>
<p>Retrying in ${retrySeconds} s… Check the network and the KITCHEN_API_URL / KEYCLOAK_URL settings.</p>
</div></body></html>`;
}
