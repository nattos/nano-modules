// precise_gate.h — pure decision logic for the "Precise" transport gate.
//
// LOCK-STEP: web/src/views/arrangement/engine/precise-gate.ts. Precise mode
// must NEVER composite a frame that isn't fully possible per the timeline — no
// layer beneath an unready video flashing through, no stale frame. Each
// invariant here had a bug that flashed (see memory: precise-transport-gate).
// Shared goldens: test_comp_time.cpp ↔ comp-goldens.test.ts.

#pragma once

#include <string>
#include <unordered_map>
#include <vector>

namespace comp {

/**
 * Are all the ACTIVE video clips ready to composite?
 *  - no video clips                          ⇒ ready (nothing to wait on)
 *  - video clips present but no decode pump  ⇒ NOT ready (a fresh-page landing
 *    must hold, not composite the video transparent — the pump is created lazily)
 *  - otherwise                               ⇒ every clip's current frame must be injected
 */
template <typename ReadyFn>
inline bool videoInputsReady(const std::vector<std::string>& activeClipIds, bool hasPump,
                             ReadyFn&& isClipReady) {
  if (activeClipIds.empty()) return true;
  if (!hasPump) return false;
  for (const auto& id : activeClipIds) {
    if (!isClipReady(id)) return false;
  }
  return true;
}

/**
 * Should Precise mode HOLD the displayed composite this frame? Only in precise
 * mode, with at least one active video clip that isn't ready, and not `force`d
 * (the fail-safe timeout bypass that prevents a genuinely-stuck decode from
 * freezing forever).
 */
inline bool shouldHoldPrecise(bool precise, bool force, int activeVideoCount, bool ready) {
  return !force && precise && activeVideoCount > 0 && !ready;
}

/**
 * The decode pump's active set for a frame. While HOLDING, the clips CURRENTLY
 * ON SCREEN (`displayed`) are kept alive alongside the `target` (active +
 * lookahead) so the held frame's textures aren't torn down; on commit only the
 * target remains. Union by clipId; `target` wins on conflict (it carries the
 * current desc). Order mirrors the TS Map semantics: displayed order first,
 * target-only entries appended in target order.
 */
template <typename T, typename IdFn>
inline std::vector<T> pumpActiveSet(bool holding, const std::vector<T>& target,
                                    const std::vector<T>& displayed, IdFn&& idOf) {
  if (!holding) return target;
  std::vector<T> out;
  out.reserve(displayed.size() + target.size());
  std::unordered_map<std::string, size_t> byId;
  for (const auto& d : displayed) {
    auto [it, inserted] = byId.try_emplace(idOf(d), out.size());
    if (inserted) out.push_back(d);
    else out[it->second] = d;
  }
  for (const auto& d : target) {
    auto [it, inserted] = byId.try_emplace(idOf(d), out.size());
    if (inserted) out.push_back(d);
    else out[it->second] = d;
  }
  return out;
}

}  // namespace comp
