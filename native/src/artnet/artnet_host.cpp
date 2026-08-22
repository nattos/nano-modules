// artnet_host.cpp — see artnet_host.h for the design contract.

#include "artnet/artnet_host.h"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <cstring>
#include <map>
#include <mutex>
#include <thread>
#include <vector>

namespace artnet {
namespace {

// ArtDmx. The opcode is LITTLE endian on the wire (0x5000 arrives as 00 50)
// while the DMX length two bytes later is BIG endian — a genuine asymmetry in
// the spec, not a typo here.
constexpr uint16_t kOpDmx = 0x5000;
constexpr size_t kHeaderLen = 18;

using Clock = std::chrono::steady_clock;

/// One universe's current state. Keyed by the packed 15-bit port address.
struct Universe {
  uint8_t channels[kMaxChannels] = {};
  int length = 0;               // channels actually carried by the last packet
  uint8_t lastSeq = 0;          // 0 = sender disabled sequencing
  uint64_t packets = 0;
  uint64_t drops = 0;           // sequence gaps (UDP reorder/loss)
  std::string src;              // dotted quad of the last sender
  Clock::time_point stamp{};
};

int portAddress(int net, int subnet, int universe) {
  return ((net & 0x7f) << 8) | ((subnet & 0x0f) << 4) | (universe & 0x0f);
}

}  // namespace

struct ArtNetHost::Impl {
  mutable std::mutex mu;
  std::map<int, Universe> universes;   // portAddress → state
  uint64_t version = 1;

  std::atomic<bool> started{false};
  std::atomic<bool> listening{false};
  std::atomic<bool> stopping{false};
  int fds[2] = {-1, -1};
  int ports[2] = {0, 0};
  std::thread rx;

  /// Parse + fold one datagram. Returns silently on anything that isn't an
  /// ArtDmx frame: the same wire carries ArtSync (0x5200), ArtPoll (0x2000)
  /// and whatever else the rig's other Art-Net devices emit.
  void ingest(const uint8_t* p, size_t n, const char* srcIp) {
    if (n < kHeaderLen) return;
    if (std::memcmp(p, "Art-Net\0", 8) != 0) return;
    const uint16_t op = (uint16_t)(p[8] | (p[9] << 8));
    if (op != kOpDmx) return;

    const int addr = ((p[15] & 0x7f) << 8) | p[14];
    int len = (p[16] << 8) | p[17];               // BIG endian
    if (len < 0) return;
    if (len > kMaxChannels) len = kMaxChannels;
    if (n < kHeaderLen + (size_t)len) len = (int)(n - kHeaderLen);
    if (len <= 0) return;

    std::lock_guard<std::mutex> lk(mu);
    Universe& u = universes[addr];

    // Sequence is 1..255 with 0 meaning "ordering disabled" — only count gaps
    // when the sender actually sequences.
    const uint8_t seq = p[12];
    if (seq != 0 && u.lastSeq != 0) {
      const uint8_t expected = (uint8_t)(u.lastSeq == 255 ? 1 : u.lastSeq + 1);
      if (seq != expected) ++u.drops;
    }
    u.lastSeq = seq;
    ++u.packets;
    u.src = srcIp ? srcIp : "";
    u.stamp = Clock::now();
    u.length = len;

    // Version bumps on CHANGE only — see the header. memcmp first so the
    // common case (a refresh loop resending an unchanged frame at 100 Hz) is
    // one compare and no write.
    if (std::memcmp(u.channels, p + kHeaderLen, (size_t)len) != 0) {
      std::memcpy(u.channels, p + kHeaderLen, (size_t)len);
      ++version;
    }
  }

  int openSocket(int port) {
    int fd = ::socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0) return -1;
    int on = 1;
    // BOTH are required, and both must be set by EVERY socket sharing the
    // port. SO_REUSEADDR alone gets EADDRINUSE against Resolume (measured).
    ::setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &on, sizeof on);
    ::setsockopt(fd, SOL_SOCKET, SO_REUSEPORT, &on, sizeof on);
    sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_port = htons((uint16_t)port);
    a.sin_addr.s_addr = INADDR_ANY;   // never an interface address
    if (::bind(fd, (sockaddr*)&a, sizeof a) != 0) { ::close(fd); return -1; }
    // A short receive timeout so the RX thread can observe `stopping`.
    timeval tv{0, 200000};
    ::setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    return fd;
  }

  void loop() {
    std::vector<uint8_t> buf(2048);
    while (!stopping.load(std::memory_order_relaxed)) {
      bool any = false;
      for (int i = 0; i < 2; ++i) {
        if (fds[i] < 0) continue;
        sockaddr_in from{};
        socklen_t fl = sizeof from;
        const ssize_t n = ::recvfrom(fds[i], buf.data(), buf.size(), 0,
                                     (sockaddr*)&from, &fl);
        if (n <= 0) continue;
        any = true;
        char ip[INET_ADDRSTRLEN] = {};
        ::inet_ntop(AF_INET, &from.sin_addr, ip, sizeof ip);
        ingest(buf.data(), (size_t)n, ip);
      }
      // Both sockets timed out: nothing on the wire, so yield rather than spin.
      if (!any) std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
  }
};

ArtNetHost::ArtNetHost() : impl_(std::make_unique<Impl>()) {}

ArtNetHost::~ArtNetHost() {
  impl_->stopping.store(true);
  if (impl_->rx.joinable()) impl_->rx.join();
  for (int i = 0; i < 2; ++i)
    if (impl_->fds[i] >= 0) ::close(impl_->fds[i]);
}

ArtNetHost& ArtNetHost::instance() {
  static ArtNetHost host;
  return host;
}

void ArtNetHost::start(int port, int mirrorPort) {
  bool expected = false;
  if (!impl_->started.compare_exchange_strong(expected, true)) return;

  impl_->ports[0] = port;
  impl_->ports[1] = (mirrorPort > 0 && mirrorPort != port) ? mirrorPort : 0;
  for (int i = 0; i < 2; ++i)
    if (impl_->ports[i] > 0) impl_->fds[i] = impl_->openSocket(impl_->ports[i]);

  if (impl_->fds[0] < 0 && impl_->fds[1] < 0) {
    // Every bind failed. Leave `started` latched so we don't retry on every
    // render tick; isListening() reports the truth and infoJson() carries it
    // to whoever is asking why nothing arrives.
    return;
  }
  impl_->listening.store(true);
  impl_->rx = std::thread([this] { impl_->loop(); });
}

bool ArtNetHost::isListening() const {
  return impl_->listening.load(std::memory_order_relaxed);
}

uint64_t ArtNetHost::version() const {
  std::lock_guard<std::mutex> lk(impl_->mu);
  return impl_->version;
}

bool ArtNetHost::sample(int net, int subnet, int universe, int base, int count,
                        float* out) const {
  if (!out || count <= 0) return false;
  std::lock_guard<std::mutex> lk(impl_->mu);
  auto it = impl_->universes.find(portAddress(net, subnet, universe));
  if (it == impl_->universes.end()) return false;   // never heard → dormant
  const Universe& u = it->second;
  for (int i = 0; i < count; ++i) {
    const int ch = base + i;                        // base is 1-based DMX
    out[i] = (ch >= 1 && ch <= u.length) ? (float)u.channels[ch - 1] / 255.0f
                                         : 0.0f;
  }
  return true;
}

nlohmann::json ArtNetHost::infoJson() const {
  nlohmann::json out = nlohmann::json::object();
  out["listening"] = isListening();
  out["port"] = impl_->ports[0];
  out["mirror_port"] = impl_->ports[1];
  nlohmann::json arr = nlohmann::json::array();
  {
    std::lock_guard<std::mutex> lk(impl_->mu);
    const auto now = Clock::now();
    for (const auto& [addr, u] : impl_->universes) {
      nlohmann::json e = nlohmann::json::object();
      e["net"] = (addr >> 8) & 0x7f;
      e["subnet"] = (addr >> 4) & 0x0f;
      e["universe"] = addr & 0x0f;
      e["src"] = u.src;
      e["age_ms"] = (int64_t)std::chrono::duration_cast<std::chrono::milliseconds>(
          now - u.stamp).count();
      e["packets"] = u.packets;
      e["drops"] = u.drops;
      e["channels"] = u.length;
      arr.push_back(std::move(e));
    }
  }
  out["universes"] = std::move(arr);
  return out;
}

void ArtNetHost::ingestForTest(const void* data, size_t size, const char* srcIp) {
  impl_->ingest((const uint8_t*)data, size, srcIp);
}

}  // namespace artnet
