// artnet_host.h — the native Art-Net (DMX-over-UDP) RECEIVER.
//
// The headless twin of the dev server's udp-bridge plugin
// (web/src/vite-plugins/udp-bridge.ts), and structurally the sibling of
// nano_midi::MidiHost: a process singleton with a background thread, a
// mutex-guarded value table, and a monotonic version() that render loops
// compare against so a static feed costs one integer compare per frame.
//
// It exists so `beatsync` (audiooptim) can drive nano sketches with the same
// drum-role triggers it already sends Resolume, WITHOUT taking them away from
// Resolume. See native/docs/ARTNET_CAPTURE.md for the wire contract and the
// measured socket-sharing matrix; the two facts that shape this file:
//
//   * WE CO-BIND A PORT SOMEONE ELSE OWNS. Resolume binds *:6454 and sets
//     SO_REUSEPORT, so we can bind it too — but ONLY if we set SO_REUSEPORT as
//     well (SO_REUSEADDR alone gets EADDRINUSE), and only BROADCAST datagrams
//     are then delivered to both of us. A unicast frame goes to exactly one
//     socket, and which one is XNU's PCB lookup rather than a promise.
//
//   * THIS SOCKET NEVER TRANSMITS. Not an ArtPollReply, not a discovery beacon,
//     nothing. That is the property that makes co-binding a live VJ rig's
//     control port safe to ship: the worst case is that we hear nothing, never
//     that Resolume does. Do not add a reply path here — put any transmitter in
//     the dev-server bridge, which is opt-in and off a production build.
//
// BIND WILDCARD, NEVER AN INTERFACE ADDRESS. A socket bound to 192.168.x.y does
// not receive that subnet's broadcast (measured) — it looks like a working
// listener that silently hears nothing, which is the same failure beatsync's
// own destination picker spent a round learning from the sending side.

#pragma once

#include <cstdint>
#include <memory>
#include <string>

#include <nlohmann/json.hpp>

namespace artnet {

/// Art-Net's port, fixed by the specification (receivers do not offer to
/// change it).
constexpr int kPort = 6454;
/// Default MIRROR port: where beatsync's `--artnet-mirror` and the dev
/// server's test-pattern generator send, so capture works without co-tenanting
/// 6454 at all. 0 disables the second socket.
constexpr int kMirrorPort = 6455;
constexpr int kMaxChannels = 512;

class ArtNetHost {
 public:
  static ArtNetHost& instance();

  /// Begin listening (idempotent; spawns the RX thread on first call). Safe to
  /// call from the render thread every frame — after the first it is an atomic
  /// load. `mirrorPort` 0 listens on kPort only.
  void start(int port = kPort, int mirrorPort = kMirrorPort);

  /// True once at least one socket is bound. A false here with packets
  /// expected means someone holds the port WITHOUT SO_REUSEPORT.
  bool isListening() const;

  /// Monotonic version of the channel tables — bumps only when a channel byte
  /// actually CHANGES. Deliberately not per packet: an idle rig still carries
  /// hundreds of packets/second (Resolume's own Art-Net output loops back into
  /// its input), and a version that ticked on arrival would make every frame
  /// look dirty.
  uint64_t version() const;

  /// Sample `count` channels starting at DMX address `base` (1-based, as a
  /// lighting desk shows it) from one universe, normalized to 0..1.
  ///
  /// Returns false when that universe has never been heard — the caller should
  /// then inject NOTHING, leaving the effect's authored value. That is the same
  /// dormant-source semantics an unseeded external-scalar rail has, and it is
  /// why a missing sender reads as "untouched" rather than as a blackout.
  ///
  /// A universe that HAS been heard and then goes quiet keeps its last values:
  /// DMX has no "off", only the current level retransmitted forever, so
  /// inventing a decay here would produce triggers the sender never sent.
  /// Freshness is reported through infoJson()'s `age_ms` instead.
  bool sample(int net, int subnet, int universe, int base, int count,
              float* out) const;

  /// Diagnostics: every universe heard, with source address, age, packet and
  /// dropped-sequence counts. Shape:
  /// `{"listening":true, "port":6454, "mirror_port":6455,
  ///   "universes":[{"net":0,"subnet":0,"universe":1,"src":"192.168.2.114",
  ///                 "age_ms":12,"packets":941,"drops":0,"channels":4}]}`
  nlohmann::json infoJson() const;

  /// Feed one datagram directly, bypassing the socket (tests). Same parse and
  /// version-gating as the RX thread.
  void ingestForTest(const void* data, size_t size, const char* srcIp);

 private:
  ArtNetHost();
  ~ArtNetHost();
  ArtNetHost(const ArtNetHost&) = delete;
  ArtNetHost& operator=(const ArtNetHost&) = delete;

  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace artnet
