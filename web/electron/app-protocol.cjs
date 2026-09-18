/**
 * Serving the built app over `nano://app/`.
 *
 * WHY NOT file:// — `vite build` emits ROOT-ABSOLUTE urls (`/assets/…`, and the
 * runtime fetches `/wasm/…` and `/fonts/…` the same way), and Chromium blocks
 * module workers outright under file://. The app constructs three of those.
 *
 * WHY NOT A LOCALHOST SERVER — an ephemeral port changes the origin on every
 * launch, and **IndexedDB is keyed by origin**: settings, projects and the live
 * cache would silently vanish each time the app started. A fixed port avoids
 * that until something else on the machine takes it. A custom scheme has one
 * stable origin by construction, opens no listening socket, and is reachable by
 * nothing but this app.
 *
 * The scheme is registered `standard` (so relative URLs, workers and
 * `import.meta.url` resolve normally), `secure` (so it counts as a secure
 * context — WebGPU and the storage APIs require one) and `supportFetchAPI` (so
 * `fetch` and XHR work, including the SYNCHRONOUS XHR wasm-host.ts uses to load
 * the shader translator).
 */

const { protocol, net } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const SCHEME = 'nano';
/** Everything is served under one host so the origin is `nano://app`. */
const HOST = 'app';
const ORIGIN = `${SCHEME}://${HOST}`;

/**
 * Must be called BEFORE `app.whenReady()` — Chromium reads the scheme registry
 * during startup and a later registration is ignored (silently, with the
 * symptom being a renderer that can't use IndexedDB or WebGPU).
 */
function registerScheme() {
  protocol.registerSchemesAsPrivileged([{
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  }]);
}

/**
 * Map a request path onto the resource root. `/wasm/...` and `/fonts/...` sit
 * beside the app rather than inside it, because the native plugin reads the
 * same directories — that is the whole point of the shared root, and it is why
 * this can't just be a static `dist/` server.
 */
function resolveRequestPath(root, urlPath) {
  const clean = decodeURIComponent(urlPath.split(/[?#]/)[0]);
  const rel = clean.replace(/^\/+/, '');
  const top = rel.split('/')[0];
  // `/wasm/...` comes from the SHARED directory, not from inside the app: the
  // native NanoBarrel plugin loads the same 33 MB of effect bundles (plus the
  // per-arch .aot sidecars beside them), and keeping a second copy in the web
  // app is precisely the duplication the shared root removes. Everything else
  // — the HTML, the JS chunks, fonts, images — is the built web app.
  const base = top === 'wasm' ? root : path.join(root, 'app');
  const file = path.resolve(base, rel || 'index.html');
  // Containment check: a `..` in the URL must not escape the root.
  const rootResolved = path.resolve(root);
  if (file !== rootResolved && !file.startsWith(rootResolved + path.sep)) return null;
  return file;
}

/**
 * Serve from `root`. Call after `app.whenReady()`.
 *
 * `nano://app/` and a bare directory fall back to `index.html`. A request for a
 * named FILE that isn't there 404s instead — falling back for those too would
 * answer a missing `/wasm/core.wasm` with 200 and a page of HTML, which
 * surfaces much later as an unintelligible wasm decode error rather than as
 * "that file isn't in the package". (This is not hypothetical: it made the
 * packaged-app test pass with the shader translator deleted.)
 */
function serve(root) {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== HOST) {
      return new Response('not found', { status: 404 });
    }
    const file = resolveRequestPath(root, url.pathname);
    if (!file) return new Response('forbidden', { status: 403 });

    let target = file;
    try {
      const stat = fs.existsSync(file) ? fs.statSync(file) : null;
      if (!stat || stat.isDirectory()) {
        // Only a route — no filename extension — gets the app shell.
        if (path.extname(file) !== '') {
          return new Response('not found', { status: 404 });
        }
        target = path.join(root, 'app', 'index.html');
        if (!fs.existsSync(target)) return new Response('not found', { status: 404 });
      }
    } catch {
      return new Response('not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(target).toString());
  });
}

module.exports = { registerScheme, serve, ORIGIN, SCHEME, resolveRequestPath };
