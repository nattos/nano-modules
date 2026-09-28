// test_compositor_protocol — the nano_compositor PROCESS, driven over its
// WebSocket exactly as the arrangement editor drives it: comp_* actions in,
// NBCJ messages (comp_report + replies) out. See tools/nano_compositor.cpp.
//
// Every case spawns a fresh process on its own port (lanes take the next 8
// ports) with a private data root, runs it on the MANUAL clock so frames happen
// only when a case asks, and reads the composite back as raw RGBA.

#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <fcntl.h>
#include <signal.h>
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>

#include <ixwebsocket/IXWebSocket.h>
#include <nlohmann/json.hpp>

extern char** environ;

using json = nlohmann::json;

#ifndef NANO_COMPOSITOR_PATH
#error "NANO_COMPOSITOR_PATH must be defined"
#endif
#ifndef NANO_TEST_DATA_ROOT
#error "NANO_TEST_DATA_ROOT must be defined"
#endif

namespace {

template <typename Pred>
bool waitFor(Pred pred, int timeoutMs = 5000) {
  const auto start = std::chrono::steady_clock::now();
  while (!pred()) {
    if (std::chrono::steady_clock::now() - start > std::chrono::milliseconds(timeoutMs))
      return false;
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  return true;
}

std::vector<uint8_t> base64Decode(const std::string& in) {
  auto val = [](char c) -> int {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
  };
  std::vector<uint8_t> out;
  uint32_t buf = 0;
  int bits = 0;
  for (char c : in) {
    const int v = val(c);
    if (v < 0) continue;
    buf = (buf << 6) | (uint32_t)v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back((uint8_t)(buf >> bits));
    }
  }
  return out;
}

json solidDoc(double r, double g, double b) {
  return {
      {"meta", {{"resolution", {{"width", 1920}, {"height", 1080}}},
                {"baseBPM", 120}, {"timeSignature", {4, 4}}}},
      {"tracks", json::array({
           {{"id", "t1"}, {"name", "t1"}, {"kind", "track"}, {"parentId", nullptr},
            {"sketch", {{"devices", json::array()}}}, {"automation", json::array()},
            {"clips", json::array({
                 {{"id", "c1"}, {"name", "c1"}, {"startBeat", 0}, {"lengthBeat", 8},
                  {"kind", "effect"},
                  {"sketch", {{"devices", json::array({
                       {{"id", "d1"}, {"moduleType", "source.solid_color"}, {"name", "solid"},
                        {"capabilities", json::array()},
                        {"state", {{"color", {r, g, b}}}}}})}}},
                  {"loop", {{"mode", "time"}, {"startSec", 0}, {"speed", 1},
                            {"direction", "forward"}}},
                  {"automation", json::array()}, {"exports", json::array()},
                  {"reads", json::array()}, {"warps", json::array()}}})}},
           {{"id", "main-bus"}, {"name", "Main Bus"}, {"kind", "group"}, {"parentId", nullptr},
            {"sketch", {{"devices", json::array()}}}, {"automation", json::array()},
            {"clips", json::array()}}})},
      {"rails", json::array()},
      {"playMode", {{"defaultMode", "time"}}},
  };
}

// One compositor process + one WS client, torn down together.
class Compositor {
 public:
  explicit Compositor(int port) : port_(port) {
    int inPipe[2], outPipe[2];
    REQUIRE(pipe(inPipe) == 0);
    REQUIRE(pipe(outPipe) == 0);
    posix_spawn_file_actions_t fa;
    posix_spawn_file_actions_init(&fa);
    posix_spawn_file_actions_adddup2(&fa, inPipe[0], STDIN_FILENO);
    posix_spawn_file_actions_adddup2(&fa, outPipe[1], STDOUT_FILENO);
    posix_spawn_file_actions_addclose(&fa, inPipe[1]);
    posix_spawn_file_actions_addclose(&fa, outPipe[0]);

    std::vector<std::string> env;
    for (char** e = environ; *e; ++e) env.emplace_back(*e);
    env.push_back(std::string("NANO_DATA_DIR=") + NANO_TEST_DATA_ROOT + "/compositor");
    std::vector<char*> envp;
    for (auto& e : env) envp.push_back(e.data());
    envp.push_back(nullptr);
    const std::string portStr = std::to_string(port);
    const char* argv[] = {NANO_COMPOSITOR_PATH, "--port", portStr.c_str(), nullptr};
    REQUIRE(posix_spawn(&pid_, NANO_COMPOSITOR_PATH, &fa, nullptr, (char* const*)argv,
                        envp.data()) == 0);
    posix_spawn_file_actions_destroy(&fa);
    close(inPipe[0]);
    close(outPipe[1]);
    stdin_ = inPipe[1];
    stdout_ = outPipe[0];

    // Ready once it prints its line (the runtime loads every bundle first).
    std::string line;
    char c;
    const auto start = std::chrono::steady_clock::now();
    while (read(stdout_, &c, 1) == 1) {
      if (c == '\n') break;
      line.push_back(c);
      if (std::chrono::steady_clock::now() - start > std::chrono::seconds(60)) break;
    }
    INFO("compositor said: " << line);
    REQUIRE(line.rfind("nano_compositor ready", 0) == 0);

    ws_.setUrl("ws://127.0.0.1:" + portStr);
    ws_.disableAutomaticReconnection();
    ws_.setOnMessageCallback([this](const ix::WebSocketMessagePtr& msg) {
      if (msg->type != ix::WebSocketMessageType::Message || !msg->binary) return;
      const std::string& b = msg->str;
      if (b.size() < 7 || b.compare(0, 4, "NBCJ") != 0) return;
      const size_t kl = (uint8_t)b[5] | ((size_t)(uint8_t)b[6] << 8);
      auto j = json::parse(b.substr(7 + kl), nullptr, false);
      if (j.is_discarded()) return;
      std::lock_guard<std::mutex> lk(mu_);
      messages_.push_back(std::move(j));
    });
    ws_.start();
    REQUIRE(waitFor([&] { return ws_.getReadyState() == ix::ReadyState::Open; }));
    send({{"action", "comp_clock"}, {"mode", "manual"}});
  }

  ~Compositor() {
    ws_.stop();
    if (stdin_ >= 0) close(stdin_);
    // Closing stdin is the shutdown signal; don't hang a failing test on it.
    if (!reap(5000) && pid_ > 0) {
      kill(pid_, SIGKILL);
      waitpid(pid_, nullptr, 0);
    }
    if (stdout_ >= 0) close(stdout_);
  }

  /// Wait up to `timeoutMs` for the process to exit; true once it has.
  bool reap(int timeoutMs) {
    if (reaped_) return true;
    reaped_ = waitFor([&] { return waitpid(pid_, nullptr, WNOHANG) == pid_; }, timeoutMs);
    return reaped_;
  }

  void send(json msg) {
    msg["key"] = "compositor";
    ws_.send(msg.dump());
  }

  /// The first message of `type` (matching reqId when given) after `from`.
  json await(const std::string& type, int reqId = -1, size_t* from = nullptr) {
    json found;
    size_t start = from ? *from : 0;
    const bool ok = waitFor([&] {
      std::lock_guard<std::mutex> lk(mu_);
      for (size_t i = start; i < messages_.size(); ++i) {
        const auto& m = messages_[i];
        if (m.value("type", std::string()) != type) continue;
        if (reqId >= 0 && m.value("reqId", -1) != reqId) continue;
        found = m;
        if (from) *from = i + 1;
        return true;
      }
      return false;
    }, 10000);
    REQUIRE(ok);
    return found;
  }

  size_t messageCount() {
    std::lock_guard<std::mutex> lk(mu_);
    return messages_.size();
  }

  /// The composite's RGBA at the centre, via comp_readback.
  std::vector<int> centre(int reqId) {
    send({{"action", "comp_readback"}, {"reqId", reqId}});
    const json r = await("readback", reqId);
    REQUIRE(r.value("hasContent", false));
    const auto px = base64Decode(r.value("pixels", std::string()));
    const int w = r.value("width", 0), h = r.value("height", 0);
    REQUIRE(px.size() == (size_t)w * h * 4);
    const size_t o = ((size_t)(h / 2) * w + w / 2) * 4;
    return {px[o], px[o + 1], px[o + 2], px[o + 3]};
  }

  void closeStdin() { close(stdin_); stdin_ = -1; }

 private:
  int port_;
  pid_t pid_ = -1;
  bool reaped_ = false;
  int stdin_ = -1;
  int stdout_ = -1;
  ix::WebSocket ws_;
  std::mutex mu_;
  std::vector<json> messages_;
};

}  // namespace

TEST_CASE("compositor: a loaded document renders and reports its structure",
          "[compositor][integration]") {
  Compositor c(8231);
  c.send({{"action", "comp_resize"}, {"width", 64}, {"height", 36}});
  c.send({{"action", "comp_load_doc"}, {"json", solidDoc(1, 0, 0).dump()}});
  c.send({{"action", "comp_control"}, {"op", "seek"}, {"beat", 2}, {"seq", 7}});
  c.send({{"action", "comp_step"}, {"frames", 2}, {"dtSec", 1.0 / 60}});

  const json rep = c.await("comp_report");
  CHECK(rep.value("hasContent", false));
  CHECK(rep.value("structureChanged", false));
  CHECK(rep.value("positionBeat", 0.0) == 2.0);
  CHECK(rep.value("controlSeq", 0.0) == 7.0);
  const auto keys = rep.value("chainKeys", json::array());
  CHECK(std::find(keys.begin(), keys.end(), "clip_c1_d1") != keys.end());
  // The layer's opacity lives on its blend instance.
  auto lt = json::parse(rep.value("layerTargets", std::string("{}")));
  CHECK(lt["t1"].value("instanceKey", std::string()) == "clip_c1_blend");

  CHECK(c.centre(1) == std::vector<int>{255, 0, 0, 255});
}

TEST_CASE("compositor: the manual clock renders only on comp_step",
          "[compositor][integration]") {
  Compositor c(8241);
  c.send({{"action", "comp_resize"}, {"width", 32}, {"height", 18}});
  c.send({{"action", "comp_load_doc"}, {"json", solidDoc(0, 0, 1).dump()}});
  c.send({{"action", "comp_step"}, {"frames", 3}, {"dtSec", 1.0 / 60}});
  size_t cursor = 0;
  for (int i = 0; i < 3; ++i) c.await("comp_report", -1, &cursor);
  // Nothing else is rendered while no step is queued.
  std::this_thread::sleep_for(std::chrono::milliseconds(200));
  const size_t settled = c.messageCount();
  std::this_thread::sleep_for(std::chrono::milliseconds(200));
  CHECK(c.messageCount() == settled);
}

TEST_CASE("compositor: play advances the transport; pause freezes it",
          "[compositor][integration]") {
  Compositor c(8251);
  c.send({{"action", "comp_resize"}, {"width", 32}, {"height", 18}});
  c.send({{"action", "comp_load_doc"}, {"json", solidDoc(1, 1, 1).dump()}});
  c.send({{"action", "comp_control"}, {"op", "seek"}, {"beat", 0}, {"seq", 1}});
  c.send({{"action", "comp_control"}, {"op", "play"}, {"seq", 2}});
  // 30 frames at 1/60 s = 0.5 s = 1 beat at 120 BPM.
  c.send({{"action", "comp_step"}, {"frames", 30}, {"dtSec", 1.0 / 60}});
  size_t cursor = 0;
  json last;
  for (int i = 0; i < 30; ++i) last = c.await("comp_report", -1, &cursor);
  CHECK(std::abs(last.value("positionBeat", 0.0) - 1.0) < 1e-6);

  c.send({{"action", "comp_control"}, {"op", "pause"}, {"seq", 3}});
  c.send({{"action", "comp_step"}, {"frames", 10}, {"dtSec", 1.0 / 60}});
  for (int i = 0; i < 10; ++i) last = c.await("comp_report", -1, &cursor);
  CHECK(std::abs(last.value("positionBeat", 0.0) - 1.0) < 1e-6);
  CHECK(last.value("controlSeq", 0.0) == 3.0);
}

TEST_CASE("compositor: a cheap param op reaches the render",
          "[compositor][integration]") {
  Compositor c(8261);
  c.send({{"action", "comp_resize"}, {"width", 32}, {"height", 18}});
  c.send({{"action", "comp_load_doc"}, {"json", solidDoc(1, 0, 0).dump()}});
  c.send({{"action", "comp_control"}, {"op", "seek"}, {"beat", 2}});
  c.send({{"action", "comp_step"}, {"frames", 1}, {"dtSec", 1.0 / 60}});
  CHECK(c.centre(1) == std::vector<int>{255, 0, 0, 255});
  c.send({{"action", "comp_op"}, {"op", "param"}, {"ownerId", "c1"}, {"deviceId", "d1"},
          {"field", "color"}, {"valueJson", "[0,1,0]"}});
  c.send({{"action", "comp_step"}, {"frames", 1}, {"dtSec", 1.0 / 60}});
  CHECK(c.centre(2) == std::vector<int>{0, 255, 0, 255});
}

TEST_CASE("compositor: exits when its parent goes away (stdin EOF)",
          "[compositor][integration]") {
  Compositor c(8271);
  c.closeStdin();
  CHECK(c.reap(5000));
}
