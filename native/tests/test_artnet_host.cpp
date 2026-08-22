// test_artnet_host.cpp — headless ArtNetHost goldens (no socket; datagrams go
// in through ingestForTest).
//
// The traps this pins, all of them things that read as "Art-Net doesn't work"
// rather than as a parse bug:
//   * the opcode is LITTLE endian on the wire and the length two bytes later
//     is BIG endian, in the same header;
//   * a universe is Net(7)|Subnet(4)|Universe(4), so "universe 17" means
//     subnet 1 / universe 1 and a receiver patched to subnet 0 sees nothing;
//   * version() must bump on CHANGE, not on arrival — the wire carries
//     hundreds of unchanged packets/second and a per-packet version would make
//     every render frame look dirty;
//   * a never-heard universe must report absent (dormant source), NOT zeros.

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cstring>
#include <vector>

#include "artnet/artnet_host.h"

using Catch::Approx;

namespace {

/// One ArtDmx frame, built the way beatsync's artnet_out.h builds it.
std::vector<uint8_t> dmx(int net, int subnet, int universe,
                         const std::vector<uint8_t>& channels, uint8_t seq = 1) {
  std::vector<uint8_t> p(18 + channels.size(), 0);
  std::memcpy(p.data(), "Art-Net\0", 8);
  p[8] = 0x00; p[9] = 0x50;            // OpDmx, little endian
  p[10] = 0x00; p[11] = 14;            // protocol 14, big endian
  p[12] = seq;
  p[13] = 0;
  p[14] = (uint8_t)(((subnet & 0x0f) << 4) | (universe & 0x0f));
  p[15] = (uint8_t)(net & 0x7f);
  p[16] = (uint8_t)((channels.size() >> 8) & 0xff);   // length, BIG endian
  p[17] = (uint8_t)(channels.size() & 0xff);
  std::memcpy(p.data() + 18, channels.data(), channels.size());
  return p;
}

void feed(const std::vector<uint8_t>& p) {
  artnet::ArtNetHost::instance().ingestForTest(p.data(), p.size(), "10.0.0.9");
}

}  // namespace

TEST_CASE("ArtDmx routes by Net|Subnet|Universe and normalizes", "[artnet_host]") {
  auto& host = artnet::ArtNetHost::instance();

  // beatsync's shape: universe 1, four channels, one per drum role.
  feed(dmx(0, 0, 1, {255, 128, 0, 64}));

  float v[4] = {-1, -1, -1, -1};
  REQUIRE(host.sample(0, 0, 1, /*base=*/1, 4, v));
  CHECK(v[0] == Approx(1.0f));
  CHECK(v[1] == Approx(128.0f / 255.0f));
  CHECK(v[2] == Approx(0.0f));
  CHECK(v[3] == Approx(64.0f / 255.0f));

  // Subnet is NOT universe: the same low nibble under a different subnet is a
  // different universe entirely.
  CHECK_FALSE(host.sample(0, 1, 1, 1, 4, v));
  feed(dmx(0, 1, 1, {10, 20}));
  REQUIRE(host.sample(0, 1, 1, 1, 2, v));
  CHECK(v[0] == Approx(10.0f / 255.0f));

  // Net likewise.
  CHECK_FALSE(host.sample(3, 0, 1, 1, 4, v));
}

TEST_CASE("a never-heard universe is absent, not zero", "[artnet_host]") {
  auto& host = artnet::ArtNetHost::instance();
  float v[4] = {9, 9, 9, 9};
  // Universe 9 has had no traffic — the caller must be able to tell "silent"
  // from "black", because injecting zeros would overwrite authored values.
  CHECK_FALSE(host.sample(0, 0, 9, 1, 4, v));
}

TEST_CASE("base_channel offsets into the universe", "[artnet_host]") {
  auto& host = artnet::ArtNetHost::instance();
  feed(dmx(0, 0, 2, {1, 2, 3, 4, 5, 6, 7, 8}));

  float v[3] = {};
  REQUIRE(host.sample(0, 0, 2, /*base=*/5, 3, v));   // DMX 5,6,7 — 1-based
  CHECK(v[0] == Approx(5.0f / 255.0f));
  CHECK(v[1] == Approx(6.0f / 255.0f));
  CHECK(v[2] == Approx(7.0f / 255.0f));

  // Past the end of what the packet carried reads 0 rather than garbage.
  float w[2] = {};
  REQUIRE(host.sample(0, 0, 2, 8, 2, w));
  CHECK(w[0] == Approx(8.0f / 255.0f));
  CHECK(w[1] == Approx(0.0f));
}

TEST_CASE("version bumps on change, not on arrival", "[artnet_host]") {
  auto& host = artnet::ArtNetHost::instance();
  feed(dmx(0, 0, 3, {5, 5}, 1));
  const uint64_t v0 = host.version();

  // A refresh loop resending an unchanged frame — 100 Hz of this is the normal
  // idle state of the wire, and none of it may dirty the render path.
  for (uint8_t s = 2; s < 10; ++s) feed(dmx(0, 0, 3, {5, 5}, s));
  CHECK(host.version() == v0);

  feed(dmx(0, 0, 3, {5, 6}, 10));
  CHECK(host.version() > v0);
}

TEST_CASE("non-ArtDmx traffic is ignored", "[artnet_host]") {
  auto& host = artnet::ArtNetHost::instance();
  feed(dmx(0, 0, 4, {77}));
  const uint64_t v0 = host.version();

  // ArtSync (0x5200) — Resolume's own output emits these alongside its frames.
  std::vector<uint8_t> sync(14, 0);
  std::memcpy(sync.data(), "Art-Net\0", 8);
  sync[8] = 0x00; sync[9] = 0x52;
  feed(sync);

  // ArtPoll (0x2000) — discovery. We must never answer it either; see the
  // header's "this socket never transmits".
  std::vector<uint8_t> poll(14, 0);
  std::memcpy(poll.data(), "Art-Net\0", 8);
  poll[8] = 0x00; poll[9] = 0x20;
  feed(poll);

  // Something that isn't Art-Net at all, and a runt.
  std::vector<uint8_t> junk = {'H', 'T', 'T', 'P', '/', '1', '.', '1', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1};
  feed(junk);
  std::vector<uint8_t> runt = {'A', 'r', 't'};
  feed(runt);

  CHECK(host.version() == v0);

  float v[1] = {};
  REQUIRE(host.sample(0, 0, 4, 1, 1, v));
  CHECK(v[0] == Approx(77.0f / 255.0f));
}

TEST_CASE("a truncated packet is clamped to what actually arrived", "[artnet_host]") {
  auto& host = artnet::ArtNetHost::instance();
  // Header claims 512 channels; only 4 bytes follow. Trusting the header would
  // read 508 bytes past the buffer.
  std::vector<uint8_t> p = dmx(0, 0, 5, {1, 2, 3, 4});
  p[16] = 0x02; p[17] = 0x00;          // claim 512
  feed(p);

  float v[4] = {};
  REQUIRE(host.sample(0, 0, 5, 1, 4, v));
  CHECK(v[0] == Approx(1.0f / 255.0f));
  CHECK(v[3] == Approx(4.0f / 255.0f));
}

TEST_CASE("infoJson reports universes and sequence drops", "[artnet_host]") {
  auto& host = artnet::ArtNetHost::instance();
  feed(dmx(0, 0, 6, {1}, 1));
  feed(dmx(0, 0, 6, {2}, 2));
  feed(dmx(0, 0, 6, {3}, 7));          // gap: 3..6 lost

  const auto info = host.infoJson();
  REQUIRE(info.contains("universes"));
  bool found = false;
  for (const auto& u : info["universes"]) {
    if (u["universe"] == 6 && u["subnet"] == 0 && u["net"] == 0) {
      found = true;
      CHECK(u["packets"] == 3);
      CHECK(u["drops"] == 1);
      CHECK(u["src"] == "10.0.0.9");
      CHECK(u["age_ms"].get<int64_t>() >= 0);
    }
  }
  CHECK(found);
}
