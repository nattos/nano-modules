#pragma once
/*
 * clip_launcher.h — turns trigger-rail events into Resolume clip launches,
 * with a reconcile loop that works around Resolume's "piano-trigger stuck-on"
 * bug.
 *
 * The shared server pump drains the process-global trigger_bus each tick and
 * hands the new events here along with the CURRENT channel→clips map (rebuilt
 * from the composition every tick, so `observed_connected` is fresh). We do NOT
 * toggle: an on/off event sets a per-clip DESIRED state, and every tick we
 * reconcile — if a clip's observed connected state disagrees with its desired
 * state, we (re)issue the connect/disconnect command, rate-limited by a
 * debounce interval. That is the whole fix: rapid on/off no longer races
 * Resolume into a stuck-on clip, because we keep driving toward the desired
 * state until Resolume actually reports it.
 *
 * The launcher never touches the Resolume WS directly — it calls a LaunchWriter
 * callback (wired in BridgeServer to resolume_client_->trigger), so it stays
 * unit-testable and free of any bridge locks.
 */

#include <cstdint>
#include <functional>
#include <map>
#include <string>
#include <vector>

#include "sketch/trigger_bus.h"

namespace bridge {

// One launchable clip: its connect-action path (the WS trigger target), the
// connected ParamState id (for a future by-id path), and the freshly-observed
// connected state used to decide whether a resend is needed.
struct LaunchTarget {
  int64_t clip_id = 0;
  std::string connect_path;
  int64_t connected_param_id = 0;
  bool observed_connected = false;
};

class ClipLauncher {
 public:
  // Sink for a launch command: connect (on=true) or disconnect (on=false) the
  // given clip. Wired to resolume_client_->trigger(target.connect_path, on).
  using LaunchWriter = std::function<void(const LaunchTarget& target, bool on)>;
  void set_writer(LaunchWriter w) { writer_ = std::move(w); }

  // Minimum ms between (re)sends for a single clip — bounds how fast we retry a
  // clip that hasn't reached its desired state, so we never toggle Resolume
  // faster than it can settle.
  void set_debounce_ms(uint64_t ms) { debounce_ms_ = ms; }

  /**
   * One pump tick:
   *  - apply `events` (channel → on/off) to the per-clip desired map, matching
   *    each event's channel against `channel_clips`;
   *  - reconcile EVERY desired clip against its fresh observed state in
   *    `channel_clips`, (re)issuing its command when they disagree and the
   *    debounce has elapsed.
   * `channel_clips` is keyed by 1-based trigger channel (matching event
   * channels); rebuild it from the composition each tick so observed states are
   * current.
   */
  void tick(const std::vector<trigger_bus::Event>& events,
            const std::map<int, std::vector<LaunchTarget>>& channel_clips,
            uint64_t now_ms);

  // Forget all desired/timing state (e.g. on Resolume disconnect / tests).
  void reset();

 private:
  LaunchWriter writer_;
  // Min ms between (re)sends to one clip. Deliberately generous: the observed
  // connected state only refreshes on Resolume's periodic CompositionState
  // rebroadcast (up to ~1s lag), and hammering connect faster than that is
  // exactly what triggers the "piano-trigger stuck-on" bug we're avoiding.
  uint64_t debounce_ms_ = 250;
  std::map<int64_t, bool> desired_;       // clip_id → desired connected
  std::map<int64_t, uint64_t> last_send_; // clip_id → last (re)send ms
};

}  // namespace bridge
