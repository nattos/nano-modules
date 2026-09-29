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
  const std::vector<artnet::NetIface> none;
  auto res = [&](const std::string& dest, const char* redirect = nullptr) {
    return ArtNetSender::resolveDest("", dest, redirect, none, &a, nullptr);
  };
  REQUIRE(res("broadcast"));
  CHECK(a.sin_addr.s_addr == htonl(0xffffffffu));
  CHECK(ntohs(a.sin_port) == 6454);
  REQUIRE(res("10.1.2.3"));
  CHECK(ntohs(a.sin_port) == 6454);
  REQUIRE(res("10.1.2.3:7000"));
  CHECK(ntohs(a.sin_port) == 7000);
  CHECK_FALSE(res("not an ip"));
  REQUIRE(res("broadcast", "127.0.0.1:9999"));
  CHECK(a.sin_addr.s_addr == htonl(0x7f000001u));
  CHECK(ntohs(a.sin_port) == 9999);
}

TEST_CASE("destinations on a named interface: its OWN broadcast, never the global one",
          "[artnet_sender]") {
  std::vector<artnet::NetIface> ifs(3);
  ifs[0] = {"en7", "10.0.5.20", "255.255.255.0", "10.0.5.255", true, false};
  ifs[1] = {"lo0", "127.0.0.1", "255.0.0.0", "", true, true};
  ifs[2] = {"en9", "2.0.0.5", "255.0.0.0", "2.255.255.255", false, false};
  sockaddr_in a{};
  std::string err;
  REQUIRE(ArtNetSender::resolveDest("en7", "broadcast", nullptr, ifs, &a, &err));
  char buf[INET_ADDRSTRLEN] = {};
  ::inet_ntop(AF_INET, &a.sin_addr, buf, sizeof buf);
  CHECK(std::string(buf) == "10.0.5.255");
  CHECK(ntohs(a.sin_port) == 6454);
  // Unicast goes where it says, from that interface.
  REQUIRE(ArtNetSender::resolveDest("en7", "10.0.5.40:7000", nullptr, ifs, &a, &err));
  CHECK(ntohs(a.sin_port) == 7000);
  // Unknown, down, or no broadcast address: an error, not 255.255.255.255.
  CHECK_FALSE(ArtNetSender::resolveDest("en5", "broadcast", nullptr, ifs, &a, &err));
  CHECK(err.find("en5") != std::string::npos);
  CHECK_FALSE(ArtNetSender::resolveDest("en9", "broadcast", nullptr, ifs, &a, &err));
  CHECK(err.find("down") != std::string::npos);
  CHECK_FALSE(ArtNetSender::resolveDest("lo0", "broadcast", nullptr, ifs, &a, &err));
  CHECK(err.find("broadcast") != std::string::npos);
  // The redirect still wins over everything.
  REQUIRE(ArtNetSender::resolveDest("en5", "broadcast", "127.0.0.1:9999", ifs, &a, &err));
  CHECK(ntohs(a.sin_port) == 9999);
}

TEST_CASE("lists this machine's interfaces (loopback among them)", "[artnet_sender]") {
  const auto ifs = ArtNetSender::interfaces();
  bool loop = false;
  for (const auto& i : ifs) loop = loop || (i.loopback && i.address == "127.0.0.1");
  CHECK(loop);
  const auto j = ArtNetSender::interfacesJson(ifs);
  REQUIRE(j.is_array());
  CHECK(j.size() == ifs.size());
}

TEST_CASE("sends from a socket bound to the named interface", "[artnet_sender]") {
  // Loopback only: lo0 (macOS) / lo (Linux), unicast to our own listener.
  REQUIRE(std::getenv("NANO_ARTNET_REDIRECT") == nullptr);
  std::string lo;
  for (const auto& i : ArtNetSender::interfaces()) if (i.loopback && i.up) lo = i.name;
  REQUIRE(!lo.empty());
  Listener rx;
  ArtNetSender tx(40.0);
  artnet::DmxFrames frames;
  frames[{lo, rx.dest(), 4}].fill(0);
  frames[{lo, rx.dest(), 4}][0] = 77;
  tx.submit(frames);
  int dmx = 0;
  for (const auto& p : rx.collect(300)) if (opcode(p) == 0x5000 && p[14] == 4 && p[18] == 77) dmx++;
  CHECK(dmx >= 5);
  CHECK_FALSE(tx.stats().contains("error"));

  // A missing interface sends nothing and says why.
  artnet::DmxFrames gone;
  gone[{"nano-no-such-if0", rx.dest(), 4}].fill(0);
  tx.submit(gone);
  rx.collect(60);
  CHECK(rx.collect(200).empty());
  const auto st = tx.stats();
  REQUIRE(st.contains("error"));
  CHECK(st["error"].get<std::string>().find("nano-no-such-if0") != std::string::npos);
}

TEST_CASE("sends the latest frames at a fixed rate, then ArtSync", "[artnet_sender]") {
  REQUIRE(std::getenv("NANO_ARTNET_REDIRECT") == nullptr);
  Listener rx;
  ArtNetSender tx(40.0);

  artnet::DmxFrames frames;
  frames[{"", rx.dest(), 1}].fill(0);
  frames[{"", rx.dest(), 1}][0] = 200;
  frames[{"", rx.dest(), 2}].fill(0);
  frames[{"", rx.dest(), 2}][3] = 100;
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
