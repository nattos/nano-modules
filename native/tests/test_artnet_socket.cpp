// test_artnet_socket.cpp — the ArtNetHost RX loop against a REAL socket.
//
// test_artnet_host.cpp feeds datagrams straight to ingestForTest, so it covers
// the parser and never the receive loop. That gap shipped a receiver that
// drained the wire at FIVE PACKETS A SECOND: the loop did a blocking recvfrom
// per socket, so whichever of the two sockets was idle stalled the thread for
// its whole SO_RCVTIMEO, once per iteration. The kernel buffer backed up, the
// values ran further behind every second, and they kept advancing for minutes
// after the sender stopped — the backlog draining, which is what "Art-Net is
// laggy" actually looked like from the outside.
//
// So this drives the socket, with BOTH ports bound and traffic on only ONE —
// the shape that triggered it. A separate binary because start() is a
// singleton latch: the port pair it first sees is the one it keeps.

#include <catch2/catch_test_macros.hpp>

#include <arpa/inet.h>
#include <sys/socket.h>
#include <unistd.h>

#include <chrono>
#include <cstring>
#include <thread>
#include <vector>

#include "artnet/artnet_host.h"

namespace {

constexpr int kPort = 34540;
constexpr int kMirror = 34541;   // bound, and deliberately left silent

std::vector<uint8_t> dmx(int universe, uint8_t value, uint8_t seq) {
  std::vector<uint8_t> p(18 + 4, 0);
  std::memcpy(p.data(), "Art-Net\0", 8);
  p[8] = 0x00; p[9] = 0x50;                       // OpDmx, little endian
  p[10] = 0x00; p[11] = 14;
  p[12] = seq;
  p[14] = (uint8_t)(universe & 0x0f);
  p[16] = 0; p[17] = 4;                           // length, big endian
  p[18] = p[19] = p[20] = p[21] = value;
  return p;
}

/// A sender aimed at the live socket, so the kernel queue is in the loop.
struct Sender {
  int fd = ::socket(AF_INET, SOCK_DGRAM, 0);
  sockaddr_in to{};
  Sender() {
    to.sin_family = AF_INET;
    to.sin_port = htons((uint16_t)kPort);
    ::inet_pton(AF_INET, "127.0.0.1", &to.sin_addr);
  }
  ~Sender() { if (fd >= 0) ::close(fd); }
  void send(uint8_t value, uint8_t seq) {
    auto p = dmx(1, value, seq);
    ::sendto(fd, p.data(), p.size(), 0, (sockaddr*)&to, sizeof to);
  }
};

int channel0() {
  float ch[4] = {};
  if (!artnet::ArtNetHost::instance().sample(0, 0, 1, 1, 4, ch)) return -1;
  return (int)(ch[0] * 255.0f + 0.5f);
}

}  // namespace

TEST_CASE("the receiver keeps up with the wire, and stops when the wire does",
          "[artnet_socket]") {
  auto& host = artnet::ArtNetHost::instance();
  host.start(kPort, kMirror);
  REQUIRE(host.isListening());
  std::this_thread::sleep_for(std::chrono::milliseconds(200));

  Sender tx;
  // 120 packets at ~100/s — an ordinary Art-Net refresh rate, and well inside
  // what a socket handles. The pre-fix loop consumed ~5 of these per second.
  constexpr int kCount = 120;
  for (int i = 1; i <= kCount; ++i) {
    tx.send((uint8_t)i, (uint8_t)((i % 255) + 1));
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }

  // KEEPS UP: the last value sent is the value we read, promptly. Generous
  // deadline — this fails by being 100+ packets behind, not by 20 ms.
  int seen = -1;
  for (int tries = 0; tries < 50 && seen != kCount; ++tries) {
    seen = channel0();
    if (seen != kCount) std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  INFO("channel 0 after the burst (expected " << kCount << ")");
  REQUIRE(seen == kCount);

  // NO BACKLOG: with the sender stopped, the value must not keep advancing.
  // This is the symptom the bug was reported as — ch_* still moving, slowly,
  // minutes after the desk went quiet.
  const int settled = channel0();
  std::this_thread::sleep_for(std::chrono::milliseconds(600));
  REQUIRE(channel0() == settled);
  std::this_thread::sleep_for(std::chrono::milliseconds(600));
  REQUIRE(channel0() == settled);
}
