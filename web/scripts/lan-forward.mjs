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

const [host, listen = '5174', target = '5173'] = process.argv.slice(2);
if (!host) {
  console.error('usage: node scripts/lan-forward.mjs <lanHost> [listenPort] [targetPort]');
  process.exit(2);
}

const connectTarget = () => {
  // Vite binds ::1 or 127.0.0.1 depending on the resolver: try both.
  const s = net.connect({ host: '::1', port: Number(target) });
  s.once('error', () => {});
  return s;
};

net.createServer((client) => {
  let upstream = connectTarget();
  upstream.once('error', () => {
    upstream = net.connect({ host: '127.0.0.1', port: Number(target) });
    upstream.once('error', () => client.destroy());
    wire(upstream);
  });
  const wire = (u) => {
    u.once('connect', () => { client.pipe(u); u.pipe(client); });
    client.once('error', () => u.destroy());
    client.once('close', () => u.destroy());
    u.once('close', () => client.destroy());
  };
  wire(upstream);
}).listen(Number(listen), host, () => {
  console.log(`forwarding ${host}:${listen} -> localhost:${target}`);
});
