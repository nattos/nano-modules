#pragma once
/*
 * clip_launcher.h — turns trigger-rail events into Resolume clip launches with a
 * per-clip reconcile state machine that is robust to Resolume's trigger latches.
 *
 * Spike findings (native/tools/piano_spike_FINDINGS.md) that shape this design:
 *
 *  1. A Piano clip's disconnect (connect:false) that reaches Resolume BEFORE the
 *     preceding connect has registered is DROPPED, latching the clip stuck-ON.
 *     A stuck clip ignores bare disconnects; only a re-arm (connect, then a
 *     disconnect after it registers) releases it.
 *  2. A Normal clip IGNORES connect:false entirely — it turns off only by
 *     EVICTION (connecting another/empty clip on the layer). After an eviction a
 *     plain connect can itself be DROPPED (stuck-OFF), cleared by re-arm
 *     (connect:false then connect:true).
 *  3. Unifying model: Resolume drops a trigger edge whose target matches its
 *     latched internal state; re-sending the SAME edge does not help — you must
 *     re-arm (send the opposite edge first), gated on the OBSERVED connected
 *     state (which we get in ~ms from a connected-param subscription, not the
 *     ~1s full-composition rebroadcast).
 *
 * The reconciler therefore:
 *   - only ever issues a disconnect while the clip is OBSERVED connected (so it
 *     never creates a stuck-ON in the first place — the gated disconnect that
 *     measured 0% stuck), and a connect only while observed disconnected;
 *   - escalates to a re-arm when a first attempt does not converge within the
 *     debounce (recovers a PRE-EXISTING stuck state, e.g. from a user click);
 *   - turns a Normal clip off by eviction, never by connect:false.
 *
 * It never touches the Resolume WS directly — it calls a RawWriter (wired in
 * BridgeServer to resolume_client_->trigger), so it stays unit-testable and
 * free of bridge locks.
 */

#include <cstdint>
#include <functional>
#include <map>
#include <string>
#include <vector>

#include "sketch/trigger_bus.h"

namespace bridge {

// One launchable clip: how to connect it, how to observe it, and how to turn it
// off given its trigger style. Rebuilt from the composition every tick so
// `observed_connected` (fed from the connected-param subscription) is fresh.
struct LaunchTarget {
  int64_t clip_id = 0;
  std::string connect_path;       // this clip's connect action (1-based)
  int64_t connected_param_id = 0; // subscribed for fast observed state
  bool observed_connected = false;
  bool is_piano = false;          // Piano style → releases on connect:false;
                                  // otherwise Normal → must be evicted
  std::string evict_path;         // connect an EMPTY clip on the same layer to
                                  // turn this clip OFF; "" if none exists
};

class ClipLauncher {
 public:
  // Sink for one raw WS trigger: (path, value). The state machine composes the
  // connect / disconnect / evict / re-arm sequences from these.
  using RawWriter = std::function<void(const std::string& path, bool value)>;
  void set_writer(RawWriter w) { writer_ = std::move(w); }

  // Min ms between (re)sends for a single clip while it hasn't converged. Small,
  // because observed state is now push-fed (~ms), not rebroadcast-gated (~1s).
  void set_debounce_ms(uint64_t ms) { debounce_ms_ = ms; }
  // Dwell between a re-arm connect and the deferred disconnect (Piano stuck-ON
  // recovery via toggle, only when the layer has no empty clip to evict with).
  void set_rearm_dwell_ms(uint64_t ms) { rearm_dwell_ms_ = ms; }
  // Hard cap on drive attempts before giving up on a clip (until its desired
  // state changes). Bounds any oscillation to a few cycles if the observed
  // state is ever wrong — we never fight Resolume forever.
  void set_max_attempts(int n) { max_attempts_ = n; }

  /**
   * One pump tick:
   *  - apply `events` (channel → on/off) to the per-clip desired map;
   *  - reconcile EVERY desired clip against its fresh observed state, driving it
   *    toward desired with the re-arm state machine above.
   * `channel_clips` is keyed by 1-based trigger channel; rebuild it from the
   * composition each tick so observed states + evict paths are current.
   */
  void tick(const std::vector<trigger_bus::Event>& events,
            const std::map<int, std::vector<LaunchTarget>>& channel_clips,
            uint64_t now_ms);

  /**
   * Best-effort one-shot: issue each event's immediate connect/disconnect edge
   * WITHOUT recording desired/reconcile state (no retry, no re-arm, no
   * convergence tracking). Used by the strict-precision deadline flush to punch
   * stale queued triggers through to Resolume when only the most recent one is
   * worth fully reconciling (via tick). Does not fight, does not track — fire
   * and forget.
   */
  void fireOnce(const std::vector<trigger_bus::Event>& events,
                const std::map<int, std::vector<LaunchTarget>>& channel_clips);

  // Forget all desired/timing state (e.g. on Resolume disconnect / tests).
  void reset();

 private:
  // Per-clip reconcile state.
  struct Recon {
    bool desired = false;
    uint64_t last_action_ms = 0;  // last send time (debounce)
    int attempts = 0;             // drive attempts since desired last changed;
                                  // 0 = try the simple edge, >0 = re-arm
    bool rearm_wait = false;      // Piano OFF: sent the re-arm connect, awaiting
                                  // the dwell before the deferred disconnect
    uint64_t rearm_at_ms = 0;
  };

  // Drive one clip toward its desired state (called per tick per desired clip).
  void reconcile_clip(const LaunchTarget& t, uint64_t now_ms);

  RawWriter writer_;
  // Observed state is the composition rebroadcast (~60ms on a live Arena), so
  // the debounce must comfortably exceed it: we send the first (low-latency)
  // edge immediately, then wait for the rebroadcast to confirm convergence
  // before escalating. Too small and we'd escalate before observed updates.
  uint64_t debounce_ms_ = 250;
  uint64_t rearm_dwell_ms_ = 120;  // > rebroadcast, so the deferred disconnect
                                   // sees the re-arm connect registered
  int max_attempts_ = 6;
  std::map<int64_t, bool> desired_;      // clip_id → desired connected
  std::map<int64_t, Recon> recon_;       // clip_id → reconcile state
};

// ── Strict-precision queue (pure decision logic) ──────────────────────────────
// A strict trigger (precision.mode == "strict") is withheld from the launcher
// until the barrel render loop presents a frame reflecting it (best-effort
// proxy), or its deadline elapses. This logic is extracted from BridgeServer so
// the invariants are unit-testable with an injected clock + present watermark
// (mirrors precise_gate). See bridge_server.cpp for the wiring.
struct StrictPending {
  trigger_bus::Event ev;
  uint64_t arrival_ms = 0;
  uint32_t deadline_ms = 0;
  uint64_t floor_present = 0;
};

struct StrictPlan {
  std::vector<trigger_bus::Event> reconcile;    // → ClipLauncher::tick (full)
  std::vector<trigger_bus::Event> best_effort;  // → ClipLauncher::fireOnce
};

/**
 * Fold this tick's freshly-drained events into the pending strict queue and
 * decide what to dispatch now. `pending` is MUTATED in place (grown with new
 * strict events, shrunk as they release/flush).
 *   - non-strict events → `reconcile` immediately;
 *   - strict events → enqueued (deadline defaults to 100ms if unset);
 *   - if ANY queued event's deadline has elapsed → flush ALL: the newest (max
 *     seq) → `reconcile`, the rest → `best_effort`; queue cleared;
 *   - else → release every event whose emitting frame is presented
 *     (`present_seq > floor_present`) to `reconcile`; the rest keep waiting.
 */
StrictPlan planStrict(const std::vector<trigger_bus::Event>& drained,
                      std::vector<StrictPending>& pending,
                      uint64_t now_ms, uint64_t present_seq);

}  // namespace bridge
