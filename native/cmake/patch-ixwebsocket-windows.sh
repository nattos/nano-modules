#!/bin/bash
# IXWebSocket 11.4.5 on Windows can stop READING a connection for good.
#
# Its Windows poll() waits with WSAEventSelect + WSAWaitForMultipleEvents, a
# fresh event object per call, with the send-request interrupt as the
# first-priority handle. WSAEventSelect's network events are edge-triggered
# (FD_WRITE is recorded only after a send failed with WSAEWOULDBLOCK and space
# came back; FD_READ only again after a recv), and an edge that lands between
# two poll() calls, or behind the interrupt, is gone. Found on real hardware:
# once one reply is too big to go out at once (the compositor's ~600 kB effect
# catalog, over a LAN), the connection thread never delivers another incoming
# message — while the sends from other threads carry on, so the socket looks
# alive. 3 runs in 4 hung that way; 0 in 6 after this.
#
# ixwebsocket already has a level-triggered path for platforms that can't wake
# poll() (select() with a short timeout, interrupt requests read before and
# after): make SelectInterruptEvent report no event handle so Windows takes it.
# Receives still wake select() at once; only a send that overflowed the socket
# buffer waits up to one timeout (20 ms) for its flush.
#
# Idempotent: a patched file no longer matches.
set -euo pipefail
f="ixwebsocket/IXSelectInterruptEvent.cpp"
[ -f "$f" ] || { echo "patch-ixwebsocket-windows: $f not found (wrong cwd?)" >&2; exit 1; }
perl -0pi -e 's{return reinterpret_cast<void\*>\(_event\);}{return nullptr;  // nano: level-triggered select() path (cmake/patch-ixwebsocket-windows.sh)}' "$f"
if grep -q 'reinterpret_cast<void\*>(_event)' "$f"; then
  echo "patch-ixwebsocket-windows: getEvent() still returns the event in $f" >&2
  exit 1
fi
echo "patch-ixwebsocket-windows: ok"
