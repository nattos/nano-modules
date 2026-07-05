// clip_launcher.cpp — see clip_launcher.h for the design contract.

#include "bridge/clip_launcher.h"

namespace bridge {

void ClipLauncher::tick(
    const std::vector<trigger_bus::Event>& events,
    const std::map<int, std::vector<LaunchTarget>>& channel_clips,
    uint64_t now_ms) {
  // 1. Apply events → desired state. An event on a channel drives EVERY clip
  //    marked with that channel toward the event's on/off. (Off events are
  //    honored so momentary/piano triggers reliably release.)
  for (const auto& ev : events) {
    auto it = channel_clips.find(ev.channel);
    if (it == channel_clips.end()) continue;
    for (const auto& target : it->second) {
      desired_[target.clip_id] = ev.on;
    }
  }
  if (!writer_) return;

  // 2. Index this tick's fresh targets by clip id, so reconcile compares
  //    against the CURRENT observed connected state (not the stale target
  //    captured when the event fired).
  std::map<int64_t, const LaunchTarget*> fresh;
  for (const auto& [channel, targets] : channel_clips) {
    for (const auto& t : targets) fresh[t.clip_id] = &t;
  }

  // 3. Reconcile: (re)issue a command for any clip whose observed state differs
  //    from its desired state, subject to the per-clip debounce.
  for (const auto& [clip_id, want_on] : desired_) {
    auto fit = fresh.find(clip_id);
    if (fit == fresh.end()) continue;  // clip no longer in the composition
    const LaunchTarget& target = *fit->second;
    if (target.observed_connected == want_on) continue;  // already there
    uint64_t& last = last_send_[clip_id];
    if (last != 0 && now_ms - last < debounce_ms_) continue;  // too soon to retry
    last = now_ms ? now_ms : 1;  // keep 0 meaning "never sent"
    writer_(target, want_on);
  }
}

void ClipLauncher::reset() {
  desired_.clear();
  last_send_.clear();
}

}  // namespace bridge
