// artnet_sender.cpp — see artnet_sender.h for the design contract.

#include "artnet/artnet_sender.h"

#include "artnet/socket_compat.h"

#ifndef _WIN32
#include <ifaddrs.h>
#include <net/if.h>
#endif

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <mutex>
#include <set>
#include <thread>
#include <tuple>

namespace artnet {
namespace {

constexpr uint16_t kOpDmx = 0x5000;
constexpr uint16_t kOpSync = 0x5200;
constexpr int kArtNetPort = 6454;

using Clock = std::chrono::steady_clock;

void header(std::vector<uint8_t>& p, uint16_t op) {
  std::memcpy(p.data(), "Art-Net\0", 8);
  p[8] = (uint8_t)(op & 0xff);          // opcode: LITTLE endian
  p[9] = (uint8_t)(op >> 8);
  p[10] = 0;                            // protocol version 14, big endian
  p[11] = 14;
}

bool parseIpPort(const std::string& s, sockaddr_in* out) {
  std::string host = s;
  int port = kArtNetPort;
  const auto colon = s.rfind(':');
  if (colon != std::string::npos) {
    host = s.substr(0, colon);
    port = std::atoi(s.c_str() + colon + 1);
    if (port <= 0 || port > 65535) return false;
  }
  std::memset(out, 0, sizeof(*out));
  out->sin_family = AF_INET;
  out->sin_port = htons((uint16_t)port);
  return ::inet_pton(AF_INET, host.c_str(), &out->sin_addr) == 1;
}

}  // namespace

std::vector<uint8_t> ArtNetSender::encodeArtDmx(int portAddress, uint8_t sequence,
                                                const uint8_t* data, int length) {
  std::vector<uint8_t> p(18 + 512, 0);
  header(p, kOpDmx);
  p[12] = sequence;
  p[13] = 0;                                    // physical
  p[14] = (uint8_t)(portAddress & 0xff);        // SubUni
  p[15] = (uint8_t)((portAddress >> 8) & 0x7f); // Net
  p[16] = 0x02;                                 // length 512, BIG endian
  p[17] = 0x00;
  if (data && length > 0) std::memcpy(p.data() + 18, data, (size_t)std::min(length, 512));
  return p;
}

std::vector<uint8_t> ArtNetSender::encodeArtSync() {
  std::vector<uint8_t> p(14, 0);
  header(p, kOpSync);
  return p;
}

bool ArtNetSender::resolveDest(const std::string& iface, const std::string& dest, const char* redirect,
                               const std::vector<NetIface>& ifaces, sockaddr_in* out, std::string* err) {
  auto fail = [&](const std::string& m) { if (err) *err = m; return false; };
  if (redirect && *redirect) {
    return parseIpPort(redirect, out) || fail("bad NANO_ARTNET_REDIRECT");
  }
  const bool bcast = dest.empty() || dest == "broadcast";
  if (!iface.empty()) {
    const NetIface* hit = nullptr;
    for (const auto& i : ifaces) if (i.name == iface) hit = &i;
    if (!hit) return fail("no network interface '" + iface + "'");
    if (!hit->up) return fail("'" + iface + "' is down");
    if (bcast) {
      if (hit->broadcast.empty()) return fail("'" + iface + "' has no broadcast address");
      return parseIpPort(hit->broadcast, out) || fail("'" + iface + "' has no broadcast address");
    }
  }
  if (bcast) return parseIpPort("255.255.255.255", out);
  return parseIpPort(dest, out) || fail("bad destination '" + dest + "'");
}

std::vector<NetIface> ArtNetSender::interfaces() {
  std::vector<NetIface> out;
#ifndef _WIN32
  ifaddrs* list = nullptr;
  if (::getifaddrs(&list) != 0) return out;
  auto str = [](const sockaddr* sa) -> std::string {
    if (!sa || sa->sa_family != AF_INET) return {};
    char buf[INET_ADDRSTRLEN] = {};
    ::inet_ntop(AF_INET, &((const sockaddr_in*)sa)->sin_addr, buf, sizeof buf);
    return buf;
  };
  for (ifaddrs* a = list; a; a = a->ifa_next) {
    if (!a->ifa_addr || a->ifa_addr->sa_family != AF_INET || !a->ifa_name) continue;
    NetIface i;
    i.name = a->ifa_name;
    i.address = str(a->ifa_addr);
    i.netmask = str(a->ifa_netmask);
    i.up = (a->ifa_flags & IFF_UP) && (a->ifa_flags & IFF_RUNNING);
    i.loopback = (a->ifa_flags & IFF_LOOPBACK) != 0;
    if (a->ifa_flags & IFF_BROADCAST) i.broadcast = str(a->ifa_broadaddr);
    // One entry per name: an interface with several IPv4 addresses keeps its first.
    bool dup = false;
    for (const auto& o : out) dup = dup || o.name == i.name;
    if (!dup) out.push_back(std::move(i));
  }
  ::freeifaddrs(list);
  std::sort(out.begin(), out.end(), [](const NetIface& x, const NetIface& y) { return x.name < y.name; });
#endif
  return out;
}

nlohmann::json ArtNetSender::interfacesJson(const std::vector<NetIface>& ifaces) {
  nlohmann::json j = nlohmann::json::array();
  for (const auto& i : ifaces) {
    j.push_back({{"name", i.name}, {"address", i.address}, {"netmask", i.netmask},
                 {"broadcast", i.broadcast}, {"up", i.up}, {"loopback", i.loopback}});
  }
  return j;
}

struct ArtNetSender::Impl {
  const std::chrono::nanoseconds period;
  const std::string redirect;

  mutable std::mutex mu;
  std::condition_variable cv;
  DmxFrames latest;
  std::string lastError;
  std::deque<Clock::time_point> sentStamps;  // one per packet, last second

  std::atomic<bool> stopping{false};
  std::thread tx;
  // TX thread only (after start): the auto socket, one bound socket per named
  // interface (with the address it was bound to — re-made when that changes),
  // the interfaces as last listed, and per-universe sequence numbers.
  net::socket_t fd = net::kInvalidSocket;
  struct Bound { net::socket_t fd = net::kInvalidSocket; std::string address; };
  std::map<std::string, Bound> bound;
  std::vector<NetIface> ifaces;
  Clock::time_point ifacesAt{};
  std::map<std::tuple<std::string, std::string, int>, uint8_t> seq;

  Impl(double hz, const char* redirectEnv)
      : period(std::chrono::nanoseconds((int64_t)(1e9 / std::max(1.0, hz)))),
        redirect(redirectEnv ? redirectEnv : "") {}

  void ensureStarted() {
    if (tx.joinable()) return;
    fd = ::socket(AF_INET, SOCK_DGRAM, 0);
    if (net::valid(fd)) {
      int on = 1;
      ::setsockopt(fd, SOL_SOCKET, SO_BROADCAST, (const char*)&on, sizeof on);
    } else {
      lastError = "socket() failed";
    }
    tx = std::thread([this] { loop(); });
  }

  void sendTo(net::socket_t s, const std::vector<uint8_t>& p, const sockaddr_in& to,
              std::string& err, int& sent) {
    const auto n = ::sendto(s, (const char*)p.data(), (int)p.size(), 0,
                            (const sockaddr*)&to, sizeof to);
    if (n < 0) err = std::string("sendto: ") + std::strerror(errno);
    else sent++;
  }

  /// The socket to send `iface`'s universes from (the auto socket under a
  /// redirect or for ""), or invalid with `err` set.
  net::socket_t socketFor(const std::string& iface, std::string& err) {
    if (iface.empty() || !redirect.empty()) return fd;
#ifdef _WIN32
    err = "choosing a network interface isn't supported on Windows yet";
    return net::kInvalidSocket;
#else
    const NetIface* hit = nullptr;
    for (const auto& i : ifaces) if (i.name == iface) hit = &i;
    if (!hit) return net::kInvalidSocket;  // resolveDest reported it
    auto& b = bound[iface];
    if (net::valid(b.fd) && b.address == hit->address) return b.fd;
    if (net::valid(b.fd)) net::closeSocket(b.fd);
    b = {};
    net::socket_t s = ::socket(AF_INET, SOCK_DGRAM, 0);
    if (!net::valid(s)) { err = "socket() failed"; return s; }
    int on = 1;
    ::setsockopt(s, SOL_SOCKET, SO_BROADCAST, (const char*)&on, sizeof on);
#ifdef IP_BOUND_IF
    // macOS: leave through THIS interface whatever the routing table says.
    const unsigned idx = ::if_nametoindex(iface.c_str());
    if (idx) ::setsockopt(s, IPPROTO_IP, IP_BOUND_IF, &idx, sizeof idx);
#endif
    sockaddr_in local{};
    local.sin_family = AF_INET;
    local.sin_port = 0;
    ::inet_pton(AF_INET, hit->address.c_str(), &local.sin_addr);
    if (::bind(s, (const sockaddr*)&local, sizeof local) != 0) {
      err = "can't bind to '" + iface + "' (" + hit->address + "): " + std::strerror(errno);
      net::closeSocket(s);
      return net::kInvalidSocket;
    }
    b = {s, hit->address};
    return s;
#endif
  }

  void loop() {
    auto next = Clock::now();
    while (!stopping.load()) {
      DmxFrames frames;
      {
        std::unique_lock<std::mutex> lk(mu);
        cv.wait_until(lk, next, [&] { return stopping.load(); });
        if (stopping.load()) break;
        frames = latest;
      }
      next += period;
      const auto now = Clock::now();
      if (next < now) next = now + period;  // a stall: skip, never burst to catch up
      if (frames.empty() || !net::valid(fd)) continue;

      // Named interfaces: re-list every 2 s (a cable pulled, DHCP renewed).
      if (redirect.empty() && now - ifacesAt > std::chrono::seconds(2)) {
        bool named = false;
        for (const auto& kv : frames) named = named || !std::get<0>(kv.first).empty();
        if (named) { ifaces = interfaces(); ifacesAt = now; }
      }

      std::string err;
      int sent = 0;
      std::set<std::tuple<net::socket_t, uint32_t, uint16_t>> syncTo;
      std::vector<std::pair<net::socket_t, sockaddr_in>> syncAddrs;
      for (const auto& [key, data] : frames) {
        const auto& [iface, dest, universe] = key;
        sockaddr_in to{};
        if (!resolveDest(iface, dest, redirect.c_str(), ifaces, &to, &err)) continue;
        const net::socket_t s = socketFor(iface, err);
        if (!net::valid(s)) continue;
        uint8_t& q = seq[key];
        q = (uint8_t)(q >= 255 ? 1 : q + 1);
        sendTo(s, encodeArtDmx(universe, q, data.data(), 512), to, err, sent);
        if (syncTo.insert({s, to.sin_addr.s_addr, to.sin_port}).second) syncAddrs.push_back({s, to});
      }
      const auto sync = encodeArtSync();
      for (const auto& [s, to] : syncAddrs) sendTo(s, sync, to, err, sent);

      std::lock_guard<std::mutex> lk(mu);
      lastError = err;
      const auto t = Clock::now();
      for (int i = 0; i < sent; i++) sentStamps.push_back(t);
      while (!sentStamps.empty() && t - sentStamps.front() > std::chrono::seconds(1)) {
        sentStamps.pop_front();
      }
    }
  }

  ~Impl() {
    stopping.store(true);
    cv.notify_all();
    if (tx.joinable()) tx.join();
    if (net::valid(fd)) net::closeSocket(fd);
    for (auto& [name, b] : bound) if (net::valid(b.fd)) net::closeSocket(b.fd);
  }
};

ArtNetSender::ArtNetSender(double hz)
    : impl_(std::make_unique<Impl>(hz, std::getenv("NANO_ARTNET_REDIRECT"))) {}

ArtNetSender::~ArtNetSender() = default;

void ArtNetSender::submit(const DmxFrames& frames) {
  std::lock_guard<std::mutex> lk(impl_->mu);
  impl_->latest = frames;
  if (!frames.empty()) impl_->ensureStarted();
}

nlohmann::json ArtNetSender::stats() const {
  std::lock_guard<std::mutex> lk(impl_->mu);
  const auto t = Clock::now();
  int pps = 0;
  for (const auto& s : impl_->sentStamps) {
    if (t - s <= std::chrono::seconds(1)) pps++;
  }
  nlohmann::json j = {{"sending", !impl_->latest.empty()}, {"pps", pps}};
  if (!impl_->lastError.empty()) j["error"] = impl_->lastError;
  return j;
}

}  // namespace artnet
