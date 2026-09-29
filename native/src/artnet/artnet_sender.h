// artnet_sender.h — the Art-Net TRANSMITTER (light devices' DMX output).
//
// Deliberately NOT part of artnet_host: the receiver co-binds Resolume's 6454
// and must never transmit (see artnet_host.h). This is its own socket on an
// ephemeral port, sending to the destinations light devices name — a node's
// address, `ip:port`, or `broadcast` (255.255.255.255:6454).
//
// Timing is the point. The render thread `submit()`s the latest mapped frames
// whenever it has them (latest wins, never queued); a thread of our own sends
// whatever is latest at a FIXED rate — ArtDmx per universe, then one ArtSync
// per destination — so the DMX cadence stays steady when rendering hitches.
// An empty submit stops sending (an output switched off goes quiet rather
// than blacking the fixtures out: something else may be driving them).
//
// NANO_ARTNET_REDIRECT=host:port sends EVERYTHING there instead. The test
// compositor always sets it, so no test ever puts a packet on the LAN.

#pragma once

#include <array>
#include <cstdint>
#include <map>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

struct sockaddr_in;

namespace artnet {

/// (destination, 15-bit port address) → 512 channels. The same type as
/// lights::Frames (light_map.h), which is what feeds it.
using DmxFrames = std::map<std::pair<std::string, int>, std::array<uint8_t, 512>>;

class ArtNetSender {
 public:
  explicit ArtNetSender(double hz = 40.0);
  ~ArtNetSender();
  ArtNetSender(const ArtNetSender&) = delete;
  ArtNetSender& operator=(const ArtNetSender&) = delete;

  /// The frames to send from the next tick on (latest wins). Starts the send
  /// thread on first use; an empty map stops sending.
  void submit(const DmxFrames& frames);

  /// `{"sending":bool, "pps":int, "error":string?}` — packets sent over the
  /// last second, and the last send error (cleared by a good send).
  nlohmann::json stats() const;

  /// ArtDmx for one universe (full 512 channels; sequence 1..255).
  static std::vector<uint8_t> encodeArtDmx(int portAddress, uint8_t sequence,
                                           const uint8_t* data, int length);
  /// ArtSync: tells nodes to latch every ArtDmx they've buffered.
  static std::vector<uint8_t> encodeArtSync();
  /// 'broadcast' | 'a.b.c.d' | 'a.b.c.d:port' → an address (port 6454 unless
  /// given). `redirect` ("host:port", e.g. NANO_ARTNET_REDIRECT) wins when set.
  static bool resolveDest(const std::string& dest, const char* redirect, sockaddr_in* out);

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace artnet
