// clip_launcher.cpp — see clip_launcher.h for the design contract.

#include "bridge/clip_launcher.h"

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

  for (const auto& [clip_id, want_on] : desired_) {
    auto fit = fresh.find(clip_id);
    if (fit == fresh.end()) continue;  // clip no longer in the composition
    reconcile_clip(*fit->second, now_ms);
  }
}

void ClipLauncher::reconcile_clip(const LaunchTarget& t, uint64_t now_ms) {
  Recon& r = recon_[t.clip_id];
  const bool want = r.desired;
  const bool have = t.observed_connected;

  // Converged: clear progress and stop. This is also what makes us race-safe —
  // we only ever act on a real mismatch, so a disconnect is only ever issued
  // while observed-connected and a connect only while observed-disconnected.
  if (have == want) {
    r.attempts = 0;
    r.last_action_ms = 0;
    r.rearm_wait = false;
    return;
  }

  // Piano stuck-ON recovery: we sent a re-arm connect last time; once the dwell
  // elapses (so it has registered), send the deferred disconnect.
  if (r.rearm_wait) {
    if (now_ms - r.rearm_at_ms < rearm_dwell_ms_) return;
    writer_(t.connect_path, false);
    r.rearm_wait = false;
    r.last_action_ms = now_ms;
    return;
  }

  // Rate-limit (re)sends. First attempt fires immediately (last_action_ms == 0).
  if (r.last_action_ms != 0 && now_ms - r.last_action_ms < debounce_ms_) return;
  const bool first = (r.attempts == 0);
  r.attempts++;
  r.last_action_ms = now_ms;

  if (want) {
    // Want ON, observed OFF. First try a plain connect; if that didn't take
    // (stuck-OFF from a prior eviction/click), re-arm: connect:false clears the
    // latch, connect:true then connects.
    if (first) {
      writer_(t.connect_path, true);
    } else {
      writer_(t.connect_path, false);
      writer_(t.connect_path, true);
      trig_log("clip %lld: re-arm connect (stuck-off recovery)",
               (long long)t.clip_id);
    }
    return;
  }

  // Want OFF, observed ON.
  if (t.is_piano) {
    // Gated disconnect (we're only here because observed-connected, i.e.
    // registered). If it doesn't release (pre-existing stuck-ON), re-arm:
    // connect, dwell so it registers, then disconnect.
    if (first) {
      writer_(t.connect_path, false);
    } else {
      writer_(t.connect_path, true);
      r.rearm_wait = true;
      r.rearm_at_ms = now_ms;
      trig_log("clip %lld: re-arm disconnect (stuck-on recovery)",
               (long long)t.clip_id);
    }
    return;
  }

  // Normal clip: connect:false is a no-op — turn it off by eviction (connect an
  // empty clip on the layer). Nothing we can do if the layer has no empty clip.
  if (!t.evict_path.empty()) {
    writer_(t.evict_path, true);
  } else {
    trig_log("clip %lld: Normal clip OFF requested but no empty clip on layer "
             "to evict with — cannot disconnect", (long long)t.clip_id);
  }
}

void ClipLauncher::reset() {
  desired_.clear();
  recon_.clear();
}

}  // namespace bridge
