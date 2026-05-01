/**
 * Vite plugin: UDP bridge — STUB.
 *
 * Placeholder for a future plugin that proxies UDP datagrams (and similar
 * non-browser-accessible protocols) through the Vite dev server, so the
 * effect IDE can talk to local hardware / OSC / ArtNet during development.
 *
 * Sketch of the intended flow:
 *
 *   browser  ── ws ──>  vite dev server  ── dgram ──>  external UDP target
 *                              ^─────── dgram ──────────/
 *
 * The plugin would:
 *   - Open a node `dgram` socket on a configurable port.
 *   - Expose a WebSocket endpoint via `server.ws` (or a sub-path).
 *   - Bidirectionally forward messages between the two.
 *   - Provide a tiny client helper (`udp-bridge-client.ts`) that exposes
 *     `send(packet: Uint8Array, target: { host, port })` and an `onMessage`
 *     callback for the browser side.
 *
 * Not implemented yet — registering this plugin is a no-op. Mounted in
 * `vite.config.ts` only so the registration site is documented in advance.
 */

import type { Plugin } from 'vite';

export function udpBridgePlugin(): Plugin {
  return {
    name: 'nano-modules:udp-bridge-stub',
    apply: 'serve',
    configureServer(_server) {
      // Future: open dgram socket; bridge to server.ws; etc.
    },
  };
}
