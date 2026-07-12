// clip_launcher.cpp — see clip_launcher.h for the design contract.

#include "bridge/clip_launcher.h"

#include <set>

#include "bridge/trig_log.h"

namespace bridge {

void ClipLauncher::tick(
    const std::vector<trigger_bus::Event>& events,
    const std::map<int, std::vector<LaunchTarget>>& channel_clips,
    uint64_t now_ms) {
  // 1. Apply events → desired state. An event on a channel drives EVERY clip
  //    marked with that channel toward the event's on/off. When a clip's desired
  //    state actually changes, reset its reconcile progress so the next tick
  //    starts from a fresh simple attempt.
  for (const auto& ev : events) {
    auto it = channel_clips.find(ev.channel);
    if (it == channel_clips.end()) continue;
    for (const auto& target : it->second) {
      bool& d = desired_[target.clip_id];
      if (d != ev.on || recon_.find(target.clip_id) == recon_.end()) {
        Recon& r = recon_[target.clip_id];
        r.desired = ev.on;
        r.attempts = 0;
        r.last_action_ms = 0;
        r.rearm_wait = false;
      }
      d = ev.on;
    }
  }
  if (!writer_) return;

  // 2. Index this tick's fresh targets by clip id (current observed state +
  //    evict paths), then reconcile every clip we have a desire for.
  std::map<int64_t, const LaunchTarget*> fresh;
  for (const auto& [channel, targets] : channel_clips)
    for (const auto& t : targets) fresh[t.clip_id] = &t;

  // Reconcile, then RELEASE every clip that has settled (reached its desired
  // state, or exhausted its attempts). We own a clip only while actively driving
  // it somewhere; a settled clip is handed back to Resolume.
  //
  // Holding the desire forever is what made a NanoLooper-marked clip unusable by
  // hand: `desired_` kept the last value the rail ever published (typically OFF),
  // so a Piano clip the user held down in Resolume — or via a MIDI button — went
  // observed-ON against a stale desired-OFF, the reconciler read that as a
  // divergence to correct, and disconnected it under them. The clip flashed on
  // and dropped while the button was still down, with nothing actually
  // triggering it.
  //
  // The stuck-clip protection this file exists for is unaffected: it only ever
  // matters while converging (a dropped trigger edge is by definition a clip that
  // has NOT reached its desired state), and a released clip re-arms from a fresh
  // simple attempt the moment the rail publishes a new edge for it.
  std::vector<int64_t> settled;
  for (const auto& [clip_id, want_on] : desired_) {
    auto fit = fresh.find(clip_id);
    if (fit == fresh.end()) continue;  // clip no longer in the composition
    if (reconcile_clip(*fit->second, now_ms)) settled.push_back(clip_id);
  }
  for (int64_t clip_id : settled) {
    desired_.erase(clip_id);
    recon_.erase(clip_id);
  }
}

bool ClipLauncher::reconcile_clip(const LaunchTarget& t, uint64_t now_ms) {
  Recon& r = recon_[t.clip_id];
  const bool want = r.desired;
  const bool have = t.observed_connected;

  // Converged: we're done — settle and let go. This is also what makes us
  // race-safe: we only ever act on a real mismatch, so a disconnect is only ever
  // issued while observed-connected and a connect only while observed-disconnected.
  if (have == want) return true;

  // Piano stuck-ON recovery: we sent a re-arm connect last time; once the dwell
  // elapses (so it has registered), send the deferred disconnect.
  if (r.rearm_wait) {
    if (now_ms - r.rearm_at_ms < rearm_dwell_ms_) return false;
    writer_(t.connect_path, false);
    r.rearm_wait = false;
    r.last_action_ms = now_ms;
    return false;
  }

  // Give up after a bounded number of attempts, and RELEASE the clip — "we never
  // fight Resolume forever" is meant literally. With accurate observed state the
  // simple first attempt converges and we never get here; this backstop means a
  // wrong/laggy observed can only ever cause a few cycles of correction, never an
  // unbounded connect/disconnect oscillation.
  if (r.attempts >= max_attempts_) {
    trig_log("clip %lld: gave up driving to %s after %d attempts "
             "(observed stuck at %s) — releasing it to Resolume",
             (long long)t.clip_id, want ? "on" : "off", r.attempts,
             have ? "on" : "off");
    return true;
  }

  // Rate-limit (re)sends. First attempt fires immediately (last_action_ms == 0).
  if (r.last_action_ms != 0 && now_ms - r.last_action_ms < debounce_ms_) return false;
  const bool first = (r.attempts == 0);
  r.attempts++;
  r.last_action_ms = now_ms;

  if (want) {
    // Want ON, observed OFF. First try a plain connect; if that didn't take
    // (stuck-OFF from a prior eviction/click), re-arm: connect:false clears the
    // latch, connect:true then connects. This sequence ENDS on a connect, so it
    // converges to ON — it cannot leave the clip toggling.
    if (first) {
      writer_(t.connect_path, true);
    } else {
      writer_(t.connect_path, false);
      writer_(t.connect_path, true);
      trig_log("clip %lld: re-arm connect (stuck-off recovery)",
               (long long)t.clip_id);
    }
    return false;
  }

  // Want OFF, observed ON.
  if (first) {
    // Piano: a gated disconnect (we're only here because observed-connected)
    // releases it. Normal: connect:false is a no-op, so go straight to evicting.
    if (t.is_piano) {
      writer_(t.connect_path, false);
    } else if (!t.evict_path.empty()) {
      writer_(t.evict_path, true);
    }
    return false;
  }

  // Escalation for a clip that won't turn off. Prefer EVICTION (connect the
  // layer's empty clip) — a single action that forces the layer off via
  // mutual-exclusion and, crucially, NEVER re-connects the target, so it cannot
  // oscillate. Only if the layer has no empty clip fall back to the re-arm
  // toggle (connect, dwell, disconnect) for a stuck-ON Piano clip.
  if (!t.evict_path.empty()) {
    writer_(t.evict_path, true);
    trig_log("clip %lld: escalate OFF via eviction", (long long)t.clip_id);
  } else if (t.is_piano) {
    writer_(t.connect_path, true);
    r.rearm_wait = true;
    r.rearm_at_ms = now_ms;
    trig_log("clip %lld: re-arm disconnect (stuck-on recovery, no evict clip)",
             (long long)t.clip_id);
  } else {
    trig_log("clip %lld: Normal clip OFF but no empty clip to evict with",
             (long long)t.clip_id);
  }
  return false;
}

void ClipLauncher::fireOnce(
    const std::vector<trigger_bus::Event>& events,
    const std::map<int, std::vector<LaunchTarget>>& channel_clips) {
  if (!writer_) return;
  for (const auto& ev : events) {
    auto it = channel_clips.find(ev.channel);
    if (it == channel_clips.end()) continue;
    for (const auto& t : it->second) {
      // The same first-attempt edge the reconciler would issue, but untracked:
      // ON → connect; OFF → gated disconnect (Piano) or eviction (Normal).
      if (ev.on) {
        writer_(t.connect_path, true);
      } else if (t.is_piano) {
        writer_(t.connect_path, false);
      } else if (!t.evict_path.empty()) {
        writer_(t.evict_path, true);
      }
      trig_log("clip %lld: best-effort flush %s (deadline)", (long long)t.clip_id,
               ev.on ? "on" : "off");
    }
  }
}

void ClipLauncher::reset() {
  desired_.clear();
  recon_.clear();
}

StrictPlan planStrict(const std::vector<trigger_bus::Event>& drained,
                      std::vector<StrictPending>& pending,
                      uint64_t now_ms, uint64_t present_seq) {
  StrictPlan plan;
  for (const auto& e : drained) {
    if (e.strict) {
      pending.push_back({e, now_ms, e.deadline_ms ? e.deadline_ms : 100u, present_seq});
    } else {
      plan.reconcile.push_back(e);  // "any" → immediate, as before
    }
  }

  bool deadline_hit = false;
  for (const auto& p : pending)
    if (now_ms - p.arrival_ms >= p.deadline_ms) { deadline_hit = true; break; }

  if (deadline_hit) {
    // Pipe assumed borked: flush ALL, fully reconcile only the newest.
    if (!pending.empty()) {
      size_t newest = 0;
      for (size_t i = 1; i < pending.size(); ++i)
        if (pending[i].ev.seq > pending[newest].ev.seq) newest = i;
      for (size_t i = 0; i < pending.size(); ++i)
        (i == newest ? plan.reconcile : plan.best_effort).push_back(pending[i].ev);
      pending.clear();
    }
  } else {
    // Present-proxy, SERIALIZED PER CHANNEL. Release at most one event per
    // channel per presented frame — otherwise a same-channel off+on emitted in
    // one frame (e.g. an abutting-note retrigger) would release together and
    // ClipLauncher::tick would fold them to the final desired state, so the
    // "off" never reaches Resolume. Holding the on until the NEXT presented
    // frame guarantees the off gets its own frame. `pending` is in seq order.
    std::vector<StrictPending> waiting;
    std::set<int> released;  // channels that already released an event this tick
    for (auto& p : pending) {
      const bool blocked = released.count(p.ev.channel) != 0;
      if (!blocked && present_seq > p.floor_present) {
        plan.reconcile.push_back(p.ev);
        released.insert(p.ev.channel);
      } else {
        // A later same-channel event must wait for a FRESH presented frame, not
        // the one that just released its predecessor.
        if (blocked && p.floor_present < present_seq) p.floor_present = present_seq;
        waiting.push_back(std::move(p));
      }
    }
    pending = std::move(waiting);
  }
  return plan;
}

}  // namespace bridge
