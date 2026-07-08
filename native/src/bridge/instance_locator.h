// instance_locator.h — correlate NanoBarrel instances with their location in
// the Resolume composition.
//
// The shared server (BridgeServer) already receives Resolume's full composition
// state over the WS API. Each NanoBarrel effect persists its instance UUID
// inside a `config` FILE param, and Resolume broadcasts that param's value
// INLINE in the composition (as a `nanobarrel://config?<base64>` string). So we
// can walk the composition, find every NanoBarrel placement, unwrap its config
// to recover the UUID (== the bridge instance key), and thus map:
//
//   Resolume composition path  <->  internal barrel instance (UUID)
//
// From that mapping we derive a human "default display name" (from the clip /
// layer / group / composition the effect sits on) and publish it into the state
// document so the editor's Organize tab can show it instead of a raw UUID.
//
// This is Phase 1. The reverse `uuid -> {paths}` map is also the substrate for
// Phase 2 (copy-paste collision detection + auto-fork), which is not built yet.

#pragma once

#include <cstdint>
#include <functional>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

namespace bridge {

class StateDocument;

// Where in the composition a NanoBarrel effect sits.
enum class PlacementScope { Clip, Layer, Group, Composition };

// Which registering plugin owns the config blob — they share the copy-paste
// collision/fork machinery but re-wrap their blob differently (a barrel carries
// a `sketch`; a NanoLooper Ch marker carries `{channel,name}`).
enum class ConfigKind { Barrel, Marker };

// One NanoBarrel effect found in the composition, with enough context to build
// a stable path key and a human default name.
struct BarrelPlacement {
  // Reconstructed JSON path (0-based array indices) — the stable location key,
  // e.g. "/layers/1/clips/0/video/effects/0".
  std::string path;
  PlacementScope scope = PlacementScope::Clip;

  // Naming context — raw Resolume names, which may contain '#' ordinal
  // templates (e.g. "Layer #"). Indices are 0-based array positions.
  std::string comp_name;
  std::string group_name;
  int group_index = -1;
  std::string layer_name;
  int layer_index = -1;
  std::string clip_name;
  int clip_index = -1;
  int chain_index = -1;  // effect's position within its effect chain

  // Raw clip `connected` ParamState value ("Connected", "Disconnected",
  // "Previewing", "Empty", …). Empty for non-clip scopes. This is the
  // live-vs-dormant signal for Phase 2 forking: a barrel on a Disconnected/Empty
  // clip has never been instantiated by the FFGL host, so rewriting its config
  // over WS can't fight a live plugin.
  std::string clip_connected;

  int64_t effect_id = 0;
  int64_t config_param_id = 0;
  std::string config_value;  // raw "nanobarrel://" or "nanoch://" config?<b64>
  ConfigKind config_kind = ConfigKind::Barrel;  // which codec owns config_value
  std::string uuid;          // resolved from config_value ("" if unresolvable)

  // A clip-mounted barrel whose clip is not Connected/Previewing — i.e. no live
  // FFGL instance exists for it. Layer/group/composition effects are always
  // considered live (never dormant), so Phase 2 never forks them.
  bool is_dormant() const;
};

/// Maintains the composition-path <-> barrel-instance mapping and publishes
/// default display names. Not thread-safe on its own — BridgeServer drives
/// `update()` from the pump thread under its tick mutex.
class InstanceLocator {
public:
  /// Walk a full composition-state JSON, (re)build the path<->uuid maps, and
  /// publish default display names for any resolved UUID that matches a
  /// registered plugin. Idempotent — safe to call every composition update.
  ///
  /// `now_ms` is a monotonic timestamp (steady clock, milliseconds) used to
  /// dwell-debounce Phase 2 collision forking. Pass 0 (the default) to disable
  /// forking entirely — the Phase 1 naming path runs regardless. Forking also
  /// requires a fork writer (see set_fork_writer); without one, update() only
  /// records collisions.
  void update(const nlohmann::json& composition, StateDocument& doc,
              uint64_t now_ms = 0);

  /// Re-run Phase 2 collision fork detection against the LAST ingested
  /// composition, without a fresh composition message. Resolume broadcasts the
  /// composition only on change, so the pump must call this every tick — the
  /// dwell timer would otherwise never re-fire on a static composition.
  /// No-op unless a fork writer is set. `now_ms` is a steady-clock millisecond
  /// timestamp; pass 0 to disable.
  void tick(uint64_t now_ms);

  // --- Phase 2: copy-paste collision forking ---

  /// Sink that writes a barrel's `config` param over the Resolume WS API:
  /// (config_param_id, new "nanobarrel://config?<base64>" blob). BridgeServer
  /// wires this to `resolume_client_->set("/parameter/by-id/<id>", id, blob)`.
  using ForkWriter = std::function<void(int64_t config_param_id,
                                        const std::string& new_config_blob)>;
  void set_fork_writer(ForkWriter w) { fork_writer_ = std::move(w); }

  /// Mints a fresh instance UUID for a forked copy. Defaults to a random
  /// UUIDv4; tests inject a deterministic counter.
  void set_uuid_minter(std::function<std::string()> m) {
    uuid_minter_ = std::move(m);
  }

  /// How long a uuid must remain at 2+ live paths before we fork the dormant
  /// duplicate(s). Long enough that a live copy's registration-time remint
  /// (`uuid-2`) + config regen round-trips and self-heals first. Default 1500ms.
  void set_dwell_ms(uint64_t ms) { dwell_ms_ = ms; }

  // --- Pure helpers (unit-tested directly, no state) ---

  /// Enumerate every registering plugin (NanoBarrel or NanoLooper Ch marker) in
  /// a full composition-state JSON, identified by a `config` param whose value
  /// starts with `nanobarrel://config?` (barrel) or `nanoch://config?` (marker);
  /// each placement's `config_kind` records which. This is a cheap STRUCTURAL
  /// walk: it fills in each
  /// placement's `config_value` but leaves `uuid` empty — resolving the UUID
  /// means base64-decoding + JSON-parsing the config blob (up to 16 MB for a
  /// large sketch), which `update()` does through a change-gated cache so an
  /// unchanged sketch is never re-decoded. Call `resolve_uuid()` yourself if you
  /// need the UUID off this static path.
  static std::vector<BarrelPlacement> enumerate(const nlohmann::json& composition);

  /// Decode the UUID from an inline `nanobarrel://config?<base64>` blob. ""
  /// on failure. Note: potentially expensive for a large sketch payload.
  static std::string resolve_uuid(const std::string& config_value);

  /// Decode the `sketch` subtree from an inline config blob, as a JSON string
  /// (so a fork can re-wrap the same sketch under a fresh UUID). "" on failure.
  static std::string resolve_sketch(const std::string& config_value);

  /// Derive a human default display name from a placement's location context
  /// (expands Resolume '#' ordinal templates).
  static std::string default_name_for(const BarrelPlacement& p);

  // --- Accessors (tests + Phase 2) ---
  std::optional<BarrelPlacement> placement_for_path(const std::string& path) const;
  std::set<std::string> paths_for_uuid(const std::string& uuid) const;
  const std::map<std::string, std::set<std::string>>& paths_by_uuid() const {
    return paths_by_uuid_;
  }

private:
  // Detect uuids at 2+ live paths that have dwelled past dwell_ms_, and fork the
  // dormant, non-canonical duplicate(s) via fork_writer_. No-op if forking is
  // disabled (now_ms == 0 or no writer). Operates on the current by_path_ /
  // paths_by_uuid_ maps, so it works both at the tail of update() and on a bare
  // tick() with no new composition.
  void detect_and_fork(uint64_t now_ms);

  std::map<std::string, BarrelPlacement> by_path_;
  std::map<std::string, std::set<std::string>> paths_by_uuid_;
  // uuid -> last name we successfully published (dedupe across ticks).
  std::map<std::string, std::string> published_names_;
  // The barrel-only uuid set we last published to
  // /global/composition_barrel_ids — change-gated (sorted) to skip redundant
  // set_at calls when the composition update didn't affect barrel placements.
  std::vector<std::string> last_published_barrel_ids_;
  // config_param_id -> {hash(config_value), uuid}. Editing a sketch changes the
  // config blob (which can be large) but NOT the UUID; this lets update() skip
  // re-decoding a config whose value hasn't changed since the last composition.
  std::map<int64_t, std::pair<uint64_t, std::string>> uuid_cache_;

  // --- Phase 2 forking state ---
  ForkWriter fork_writer_;
  std::function<std::string()> uuid_minter_;
  uint64_t dwell_ms_ = 1500;
  // uuid -> the first now_ms at which it was seen as a >=2-path collision.
  // Cleared once it drops back below 2 paths.
  std::map<std::string, uint64_t> collision_since_;
  // config_param_id -> hash(config_value) we last issued a fork write against.
  // Guards against re-issuing the same fork while Resolume's write-back is in
  // flight (the blob still hashes to the value we forked from).
  std::map<int64_t, uint64_t> forked_configs_;
};

}  // namespace bridge
