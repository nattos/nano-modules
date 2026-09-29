// test_artnet_sender.cpp — the Art-Net TRANSMITTER against a real loopback
// socket: packet layout (ArtDmx + ArtSync), destination parsing, and the fixed
// send cadence that keeps DMX steady while whoever submits frames stalls.
//
// Every packet goes to 127.0.0.1 on a test port — never to 6454, where a
// running Resolume (or our own receiver) would hear it.

#include <catch2/catch_test_macros.hpp>

#include <arpa/inet.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <chrono>
#include <cstdlib>
#include <cstring>
#include <thread>
#include <vector>

#include "artnet/artnet_sender.h"

using artnet::ArtNetSender;
using Clock = std::chrono::steady_clock;

namespace {

/// A loopback receiver on an ephemeral port.
struct Listener {
  int fd = ::socket(AF_INET, SOCK_DGRAM, 0);
  int port = 0;
  Listener() {
    sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_port = 0;
    ::inet_pton(AF_INET, "127.0.0.1", &a.sin_addr);
    ::bind(fd, (sockaddr*)&a, sizeof a);
    socklen_t len = sizeof a;
    ::getsockname(fd, (sockaddr*)&a, &len);
    port = ntohs(a.sin_port);
  }
  ~Listener() { ::close(fd); }
  std::string dest() const { return "127.0.0.1:" + std::to_string(port); }
  /// Every datagram that arrives within `ms`.
  std::vector<std::vector<uint8_t>> collect(int ms) {
    std::vector<std::vector<uint8_t>> out;
    const auto until = Clock::now() + std::chrono::milliseconds(ms);
    while (Clock::now() < until) {
      pollfd p{fd, POLLIN, 0};
      const int left = (int)std::chrono::duration_cast<std::chrono::milliseconds>(until - Clock::now()).count();
      if (::poll(&p, 1, std::max(1, left)) <= 0) continue;
      std::vector<uint8_t> buf(1024);
      const auto n = ::recv(fd, buf.data(), buf.size(), 0);
      if (n > 0) { buf.resize((size_t)n); out.push_back(std::move(buf)); }
    }
    return out;
  }
};

uint16_t opcode(const std::vector<uint8_t>& p) { return (uint16_t)(p[8] | (p[9] << 8)); }

}  // namespace

TEST_CASE("ArtDmx and ArtSync layout", "[artnet_sender]") {
  uint8_t data[512] = {};
  data[0] = 7; data[511] = 9;
  const auto p = ArtNetSender::encodeArtDmx(0x123, 5, data, 512);
  REQUIRE(p.size() == 18 + 512);
  CHECK(std::memcmp(p.data(), "Art-Net\0", 8) == 0);
  CHECK(opcode(p) == 0x5000);
  CHECK(p[11] == 14);
  CHECK(p[12] == 5);
  CHECK(p[14] == 0x23);   // SubUni
  CHECK(p[15] == 0x01);   // Net
  CHECK(p[16] == 0x02); CHECK(p[17] == 0x00);
  CHECK(p[18] == 7); CHECK(p[18 + 511] == 9);

  const auto s = ArtNetSender::encodeArtSync();
  CHECK(s.size() == 14);
  CHECK(opcode(s) == 0x5200);
}

TEST_CASE("destinations: broadcast, ip, ip:port, and the redirect", "[artnet_sender]") {
  sockaddr_in a{};
  REQUIRE(ArtNetSender::resolveDest("broadcast", nullptr, &a));
  CHECK(a.sin_addr.s_addr == htonl(0xffffffffu));
  CHECK(ntohs(a.sin_port) == 6454);
  REQUIRE(ArtNetSender::resolveDest("10.1.2.3", nullptr, &a));
  CHECK(ntohs(a.sin_port) == 6454);
  REQUIRE(ArtNetSender::resolveDest("10.1.2.3:7000", nullptr, &a));
  CHECK(ntohs(a.sin_port) == 7000);
  CHECK_FALSE(ArtNetSender::resolveDest("not an ip", nullptr, &a));
  REQUIRE(ArtNetSender::resolveDest("broadcast", "127.0.0.1:9999", &a));
  CHECK(a.sin_addr.s_addr == htonl(0x7f000001u));
  CHECK(ntohs(a.sin_port) == 9999);
}

TEST_CASE("sends the latest frames at a fixed rate, then ArtSync", "[artnet_sender]") {
  REQUIRE(std::getenv("NANO_ARTNET_REDIRECT") == nullptr);
  Listener rx;
  ArtNetSender tx(40.0);

  artnet::DmxFrames frames;
  frames[{rx.dest(), 1}].fill(0);
  frames[{rx.dest(), 1}][0] = 200;
  frames[{rx.dest(), 2}].fill(0);
  frames[{rx.dest(), 2}][3] = 100;
  tx.submit(frames);
  // Nobody submits again for half a second — the stalled render thread — and
  // the cadence must hold anyway.
  const auto got = rx.collect(500);

  int dmx1 = 0, dmx2 = 0, syncs = 0;
  uint8_t lastSeq = 0;
  bool seqOk = true;
  for (const auto& p : got) {
    if (opcode(p) == 0x5200) { syncs++; continue; }
    REQUIRE(opcode(p) == 0x5000);
    if (p[14] == 1) {
      dmx1++;
      CHECK(p[18] == 200);
      if (lastSeq != 0 && p[12] != (uint8_t)(lastSeq >= 255 ? 1 : lastSeq + 1)) seqOk = false;
      lastSeq = p[12];
    } else if (p[14] == 2) {
      dmx2++;
      CHECK(p[18 + 3] == 100);
    }
  }
  // 40 Hz for 0.5 s ≈ 20 rounds (generous bounds: a loaded CI box jitters).
  CHECK(dmx1 >= 14);
  CHECK(dmx1 <= 22);
  CHECK(dmx2 == dmx1);
  CHECK(syncs == dmx1);   // one destination → one ArtSync per round
  CHECK(seqOk);
  CHECK(tx.stats()["sending"] == true);
  CHECK(tx.stats()["pps"].get<int>() > 0);

  // An empty submit stops sending.
  tx.submit({});
  rx.collect(60);  // drain a round in flight
  CHECK(rx.collect(200).empty());
  CHECK(tx.stats()["sending"] == false);
}
