// artnet_sender.cpp — see artnet_sender.h for the design contract.

#include "artnet/artnet_sender.h"

#include "artnet/socket_compat.h"

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

bool ArtNetSender::resolveDest(const std::string& dest, const char* redirect, sockaddr_in* out) {
  if (redirect && *redirect) return parseIpPort(redirect, out);
  if (dest.empty() || dest == "broadcast") return parseIpPort("255.255.255.255", out);
  return parseIpPort(dest, out);
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
  net::socket_t fd = net::kInvalidSocket;
  std::map<std::pair<std::string, int>, uint8_t> seq;  // TX thread only

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

  void sendTo(const std::vector<uint8_t>& p, const sockaddr_in& to, std::string& err, int& sent) {
    const auto n = ::sendto(fd, (const char*)p.data(), (int)p.size(), 0,
                            (const sockaddr*)&to, sizeof to);
    if (n < 0) err = std::string("sendto: ") + std::strerror(errno);
    else sent++;
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

      std::string err;
      int sent = 0;
      std::set<std::tuple<uint32_t, uint16_t>> syncTo;
      std::vector<sockaddr_in> syncAddrs;
      for (const auto& [key, data] : frames) {
        sockaddr_in to{};
        if (!resolveDest(key.first, redirect.c_str(), &to)) {
          err = "bad destination '" + key.first + "'";
          continue;
        }
        uint8_t& s = seq[key];
        s = (uint8_t)(s >= 255 ? 1 : s + 1);
        sendTo(encodeArtDmx(key.second, s, data.data(), 512), to, err, sent);
        if (syncTo.insert({to.sin_addr.s_addr, to.sin_port}).second) syncAddrs.push_back(to);
      }
      const auto sync = encodeArtSync();
      for (const auto& to : syncAddrs) sendTo(sync, to, err, sent);

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
