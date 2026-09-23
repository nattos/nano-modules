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
const { Readable } = require('stream');
const moduleDirs = require('./module-dirs.cjs');

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

/** `/__media/<encoded absolute path>` — see serveMedia. */
const MEDIA_PREFIX = '/__media/';

const MEDIA_TYPES = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif', '.svg': 'image/svg+xml',
};

/**
 * Parse a single-range `Range` header against a file of `size` bytes:
 * `[start, end]` inclusive, `null` for no/unsupported range (serve it all),
 * or `'unsatisfiable'`.
 */
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;  // multi-range etc.: whole file
  let start;
  let end;
  if (m[1] === '') {
    // Suffix: the last N bytes.
    const n = Number(m[2]);
    if (n === 0) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return [start, end];
}

/**
 * Local media, streamed from disk with Range support — how the arrangement's
 * decoders read a clip in the desktop app (src/state/paths.ts
 * `openMediaSource`). A `blob:` URL would need the whole file in memory first,
 * because an fs-backed file handle can't produce a disk-backed `File`.
 *
 * Any absolute path is servable. That grants nothing new: the renderer runs
 * with nodeIntegration and can already read any file the user can. CORS is
 * open because in development the page is on the vite dev server's origin,
 * not nano://app.
 */
async function serveMedia(request, pathname) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Range',
    'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  let file;
  try {
    file = decodeURIComponent(pathname.slice(MEDIA_PREFIX.length));
  } catch {
    return new Response('bad path', { status: 400, headers: cors });
  }
  if (!path.isAbsolute(file)) return new Response('bad path', { status: 400, headers: cors });
  let stat;
  try {
    stat = await fs.promises.stat(file);
  } catch {
    return new Response('not found', { status: 404, headers: cors });
  }
  if (!stat.isFile()) return new Response('not found', { status: 404, headers: cors });

  const size = stat.size;
  const headers = {
    ...cors,
    'Content-Type': MEDIA_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
  };
  const range = parseRange(request.headers.get('range'), size);
  if (range === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
  }
  const [start, end] = range ?? [0, size - 1];
  const length = size === 0 ? 0 : end - start + 1;
  headers['Content-Length'] = String(length);
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  const body = request.method === 'HEAD' || length === 0
    ? null
    : Readable.toWeb(fs.createReadStream(file, { start, end }));
  return new Response(body, { status: range ? 206 : 200, headers });
}

/**
 * Serve from `root`. Call after `app.whenReady()`. `root` is null when the
 * page comes from the dev server: then only the media route answers.
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
    if (url.pathname.startsWith(MEDIA_PREFIX)) return serveMedia(request, url.pathname);
    if (!root) return new Response('not found', { status: 404 });
    // `/modules/<n>/<file>.wasm` — an effect bundle from the per-user or a
    // mapped module directory (module-dirs.cjs), which live OUTSIDE the root.
    // Resolved against the config on every request, so a newly mapped
    // directory is servable without a restart; only the configured
    // directories, only .wasm files, never a `..` escape.
    if (url.pathname.startsWith('/modules/')) {
      const mod = moduleDirs.resolveModuleUrl(url.pathname);
      if (!mod || !fs.existsSync(mod)) return new Response('not found', { status: 404 });
      return net.fetch(pathToFileURL(mod).toString());
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

module.exports = { registerScheme, serve, ORIGIN, SCHEME, resolveRequestPath, parseRange };
