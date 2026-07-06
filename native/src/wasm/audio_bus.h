#pragma once
// audio_bus.h — process-global, thread-safe, multi-listener fan-out for effect
// audio triggers.
//
// A WASM effect calls host.trigger_audio(channel) on a gate-on (e.g.
// control.nanolooper's per-channel note). The WAMR host (host_functions.cpp)
// forwards each event here, tagged with the firing effect INSTANCE's namespaced
// key. Any number of native listeners (the NanoLooper FFGL shells, each driving
// its own Synth) register a callback + opaque token and filter by the instance
// key they own — so multiple loopers in one Resolume process each hear only
// their own triggers.
//
// Deliberately dependency-free (like effect_host_sink.h) so both the wasm host
// (host_functions.cpp) and the bridge ABI (bridge_api.cpp) can call it without a
// layering cycle. Registration and fan-out are mutex-guarded: register on the
// GL/main thread, fire on the render thread.

#include <cstdint>

namespace audio_bus {

// userdata = the listener's own pointer; instance_key = namespaced key of the
// effect instance that fired (e.g. "<executorKey>/looper"); channel is 0-based.
using Listener = void (*)(void* userdata, const char* instance_key, int channel);

// Register a listener; returns a nonzero token used to remove it (0 if fn is
// null). Thread-safe.
uint64_t add(Listener fn, void* userdata);

// Remove a previously-added listener by token. No-op on an unknown/zero token.
// Thread-safe; safe to call during teardown.
void remove(uint64_t token);

// Fan the event out to every registered listener. Snapshots the listener list
// under the lock and invokes each OUTSIDE the lock, so a listener may register/
// remove from within its callback without deadlock, and a slow listener never
// blocks registration.
void fire(const char* instance_key, int channel);

}  // namespace audio_bus
