#!/usr/bin/env node
// lan-forward.mjs — expose the local dev server on this machine's LAN address,
// for runs where ANOTHER machine has to reach it: a remote compositor fetches
// the page's media from the page's own origin (test/comp-backend.ts, REMOTE).
//
//   node scripts/lan-forward.mjs <lanHost> [listenPort=5174] [targetPort=5173]
//
// A plain TCP forward to the loopback-bound dev server (HMR's websocket rides
// it too), so the dev server itself is left exactly as it was. Stop it when
// done: it serves whatever the dev server serves to anyone on the network.

import net from 'node:net';
import { pipeline } from 'node:stream';

const [host, listen = '5174', target = '5173'] = process.argv.slice(2);
if (!host) {
  console.error('usage: node scripts/lan-forward.mjs <lanHost> [listenPort] [targetPort]');
  process.exit(2);
}

/** The dev server binds ::1 or 127.0.0.1 depending on the resolver: try both. */
function connectUpstream(cb) {
  const tryHost = (hosts) => {
    const s = net.connect({ host: hosts[0], port: Number(target) });
    s.once('connect', () => cb(s));
    s.once('error', (e) => (hosts.length > 1 ? tryHost(hosts.slice(1)) : cb(null, e)));
  };
  tryHost(['::1', '127.0.0.1']);
}

net.createServer((client) => {
  client.pause();
  connectUpstream((up) => {
    if (!up) { client.destroy(); return; }
    // pipeline() ends each side only after the other's data is flushed — a
    // destroy-on-close here truncated responses (a half-downloaded .mov).
    pipeline(client, up, () => {});
    pipeline(up, client, () => {});
    client.resume();
  });
}).listen(Number(listen), host, () => {
  console.log(`forwarding ${host}:${listen} -> localhost:${target}`);
});
