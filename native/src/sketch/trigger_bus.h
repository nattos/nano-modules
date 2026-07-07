#pragma once
/*
 * trigger_bus.h — process-global TRIGGER RAIL: an event bus carrying discrete
 * on/off trigger events out of the sketch executors, to be drained by the
 * shared server (which launches Resolume clips) and mirrored to the editor UI.
 *
 * This is the event-shaped counterpart of sidechannel_bus: same process-global
 * sharing domain (one bridge-server dylib on native; one executor.wasm memory
 * on web), same single leaf mutex, same "never touch BridgeServer/tick_mutex_
 * from in here" rule. Where the sidechannel bus copies a GPU texture, this bus
 * queues small trigger EVENTS: {seq, channel, on, velocity} on a named rail.
 *
 * Emitters: any TriggerSource stage (util.trigger_out, control.nanolooper,
 * mod.trigger.beat) publishes a "triggers" ring in its state; the executor
 * drains that ring post-tick and calls emit() here (see sketch_executor.cpp).
 * The payload deliberately mirrors the arrangement compositor's extensible
 * {seq,on,channel,velocity,...} contract, so the two can eventually unify.
 *
 * Optional "precision" subtree (the first structured sub-payload): an event may
 * carry {"precision":{"mode":"any"|"strict","deadline":<ms>}}. "any" (the
 * default when the subtree is absent) is dispatched immediately as before. In
 * "strict" mode the BridgeServer pump withholds the outbound clip launch until
 * a rendered barrel frame reflecting the trigger has reached the display, then
 * releases it; a `deadline` (ms) bounds the wait — on expiry the pump flushes
 * all pending strict events but fully reconciles only the newest. Decoded here
 * to `strict` + `deadline_ms` (only the two modes exist).
 *
 * Consumers: the BridgeServer pump drains() the bus each tick (native only) to
 * launch matching clips; the editor polls version()/infoJson() for the
 * Instances-tab "Trigger Rails" cards. Web has no server, so nothing launches
 * there — the bus still drives the UI.
 *
 * Rails: only the default global rail exists for now (kGlobalRail). The API
 * carries a rail id on every event so named rails drop in later without a
 * signature change.
 */

#include <cstdint>
#include <string>
#include <vector>

namespace trigger_bus {

// The default (and, for now, only) rail. Matches the compositor's sentinel so
// the two vocabularies already line up (comp_model.h kGlobalTriggerRailId).
inline constexpr const char* kGlobalRail = "__triggers__";

struct Event {
  uint64_t seq = 0;         // monotonic, assigned by the bus at emit()
  std::string rail;         // rail id (kGlobalRail for now)
  int channel = 0;          // trigger channel (scene/clip channel id)
  bool on = false;          // on-edge vs off-edge
  float velocity = 0.0f;    // placeholder; consumers may ignore
  std::string writerTag;    // emitting instance identity (UI/debug)
  bool strict = false;      // precision.mode == "strict" (else "any")
  uint32_t deadline_ms = 0; // precision.deadline; meaningful only when strict
};

/**
 * Emit one trigger event onto `rail` (null/empty → kGlobalRail). The bus
 * assigns a monotonic seq. `writerTag` is the emitter's identity string
 * (instance key), surfaced in infoJson for UI labels. `strict`/`deadlineMs`
 * carry the optional precision subtree (strict=false → "any", today's
 * immediate dispatch). Bounded history: the oldest event is dropped once the
 * log is full (consumers drain every tick).
 */
void emit(const char* rail, int channel, bool on, float velocity,
          const char* writerTag, bool strict = false, uint32_t deadlineMs = 0);

/**
 * Return every event newer than what `consumerId` last drained, in seq order,
 * and advance that consumer's watermark to the newest event. A brand-new
 * consumer starts at 0 and receives whatever is still in the bounded log. Used
 * by the server pump; each distinct consumer keeps its own watermark.
 */
std::vector<Event> drain(const char* consumerId);

/** Bumped when rail METADATA changes (a rail/channel first seen, or a new
 *  writer on a channel) — NOT per event, so hosts can gate UI pushes on it. */
uint64_t version();

/**
 * Serialize per-rail/channel activity as JSON — `{"<rail>": {"<channel>":
 * {"on":bool,"velocity":num,"writer":tag,"seq":num[,"precision":{...}]}}}` —
 * (the precision object appears only for a strict channel) into `out` (capacity
 * `cap`). Returns the FULL byte length (retry with a bigger buffer if > cap).
 * Pair with version() to push the editor's Trigger Rails cards.
 */
int32_t infoJson(char* out, int32_t cap);

/** Clear all events + watermarks + metadata (tests only). */
void resetForTest();

}  // namespace trigger_bus
