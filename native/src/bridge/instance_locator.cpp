#include "bridge/instance_locator.h"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <random>

#include "bridge/state_document.h"
#include "plugin/nano_barrel/barrel_codec.h"
#include "plugin/nano_barrel/channel_marker_codec.h"

namespace bridge {
namespace {

using nlohmann::json;

// A random UUIDv4 string (uppercase, hyphenated) — matches the plugin's
// NSUUID-style format so a forked copy is indistinguishable from a freshly
// minted one. Used as the default fork uuid minter.
std::string random_uuid() {
  static thread_local std::mt19937_64 rng(std::random_device{}());
  uint64_t hi = rng(), lo = rng();
  // Set version (4) and variant (10xx) bits.
  hi = (hi & 0xffffffffffff0fffull) | 0x0000000000004000ull;
  lo = (lo & 0x3fffffffffffffffull) | 0x8000000000000000ull;
  unsigned char b[16];
  for (int i = 0; i < 8; i++) b[i] = (unsigned char)(hi >> (56 - 8 * i));
  for (int i = 0; i < 8; i++) b[8 + i] = (unsigned char)(lo >> (56 - 8 * i));
  static const char* hex = "0123456789ABCDEF";
  char out[37];
  int p = 0;
  for (int i = 0; i < 16; i++) {
    if (i == 4 || i == 6 || i == 8 || i == 10) out[p++] = '-';
    out[p++] = hex[b[i] >> 4];
    out[p++] = hex[b[i] & 0xf];
  }
  out[p] = '\0';
  return std::string(out);
}

// Read a Resolume "name"-style field: usually {value:"..."} but tolerate a
// plain string.
std::string read_name(const json& node) {
  if (node.is_string()) return node.get<std::string>();
  if (node.is_object()) {
    auto v = node.find("value");
    if (v != node.end() && v->is_string()) return v->get<std::string>();
  }
  return "";
}

struct ConfigRef {
  int64_t id = 0;
  std::string value;
  ConfigKind kind = ConfigKind::Barrel;
};

// If `effect` is a registering plugin — identified by a `config` param whose
// value is a `nanobarrel://config?...` (barrel) or `nanoch://config?...`
// (marker) blob — return its config param id + value + which codec owns it.
// This is the robust identifier (survives the effect's display name / FFGL-code
// differences across Resolume versions).
std::optional<ConfigRef> effect_config(const json& effect) {
  if (!effect.is_object()) return std::nullopt;
  auto params = effect.find("params");
  if (params == effect.end() || !params->is_object()) return std::nullopt;
  auto cfg = params->find("config");
  if (cfg == params->end() || !cfg->is_object()) return std::nullopt;
  auto v = cfg->find("value");
  if (v == cfg->end() || !v->is_string()) return std::nullopt;
  std::string val = v->get<std::string>();
  const int64_t id = cfg->value("id", (int64_t)0);
  if (val.rfind(barrel_codec::kConfigPrefix, 0) == 0)
    return ConfigRef{id, std::move(val), ConfigKind::Barrel};
  if (val.rfind(channel_marker::kConfigPrefix, 0) == 0)
    return ConfigRef{id, std::move(val), ConfigKind::Marker};
  return std::nullopt;
}

// FNV-1a over a byte string — a cheap change-detector for config blobs so we
// avoid re-decoding an unchanged (possibly multi-MB) sketch payload.
uint64_t fnv1a(const std::string& s) {
  uint64_t h = 1469598103934665603ull;
  for (unsigned char c : s) {
    h ^= c;
    h *= 1099511628211ull;
  }
  return h;
}

// A node's `video.effects` array, or nullptr.
const json* video_effects(const json& node) {
  auto v = node.find("video");
  if (v == node.end() || !v->is_object()) return nullptr;
  auto e = v->find("effects");
  if (e == v->end() || !e->is_array()) return nullptr;
  return &(*e);
}

// Append any barrels found in an `effects` array to `out`, using `base` for the
// already-filled scope + naming context.
void scan_effects(const json& effects, const std::string& path_prefix,
                  const BarrelPlacement& base, std::vector<BarrelPlacement>& out) {
  for (size_t k = 0; k < effects.size(); k++) {
    const json& eff = effects[k];
    auto cfg = effect_config(eff);
    if (!cfg) continue;
    BarrelPlacement p = base;
    p.chain_index = (int)k;
    p.path = path_prefix + "/" + std::to_string(k);
    p.effect_id = eff.value("id", (int64_t)0);
    p.config_param_id = cfg->id;
    p.config_value = cfg->value;
    p.config_kind = cfg->kind;
    // uuid left empty — update() resolves it through a change-gated cache so a
    // large, unchanged config blob is never re-decoded.
    out.push_back(std::move(p));
  }
}

// Expand Resolume's '#' ordinal placeholder (e.g. "Layer #" -> "Layer 3").
std::string expand_hash(const std::string& name, int ordinal) {
  if (name.find('#') == std::string::npos) return name;
  std::string ord = std::to_string(ordinal);
  std::string out;
  out.reserve(name.size() + ord.size());
  for (char c : name) {
    if (c == '#') out += ord;
    else out += c;
  }
  return out;
}

// Display names for a placement's track / clip / group, with '#' expanded and a
// numbered fallback when Resolume gave no name. Shared by default_name_for and
// placement_json so the composed name and the structured fields agree.
std::string track_display(const BarrelPlacement& p) {
  std::string n = expand_hash(p.layer_name, p.layer_index + 1);
  return n.empty() ? "Layer " + std::to_string(p.layer_index + 1) : n;
}
std::string clip_display(const BarrelPlacement& p) {
  std::string n = expand_hash(p.clip_name, p.clip_index + 1);
  return n.empty() ? "Clip " + std::to_string(p.clip_index + 1) : n;
}
std::string group_display(const BarrelPlacement& p) {
  std::string n = expand_hash(p.group_name, p.group_index + 1);
  return n.empty() ? "Group " + std::to_string(p.group_index + 1) : n;
}

// Structured placement fields the web Instances tab uses to organize cards into
// composition-ordered rows (one per group / track, plus a "Main" row for
// composition effects). Carries pre-resolved display names + array indices so
// the web renders row headers directly without re-deriving them from `location`.
// Only the fields relevant to the scope are present. Published alongside the
// resolved default name in BOTH `set_plugin_resolume_info` (launched instances,
// via `/global/plugins[].resolume`) and `/global/composition_barrel_ids`
// (unlaunched placeholders).
nlohmann::json placement_json(const BarrelPlacement& p) {
  nlohmann::json j;
  switch (p.scope) {
    case PlacementScope::Clip:
      j["scope"] = "clip";
      j["track_index"] = p.layer_index;
      j["track_name"] = track_display(p);
      j["clip_index"] = p.clip_index;
      j["clip_name"] = clip_display(p);
      break;
    case PlacementScope::Layer:
      j["scope"] = "layer";
      j["track_index"] = p.layer_index;
      j["track_name"] = track_display(p);
      break;
    case PlacementScope::Group:
      j["scope"] = "group";
      j["group_index"] = p.group_index;
      j["group_name"] = group_display(p);
      break;
    case PlacementScope::Composition:
      j["scope"] = "composition";
      break;
  }
  if (p.chain_index >= 0) j["chain_index"] = p.chain_index;
  return j;
}

}  // namespace

std::vector<BarrelPlacement> InstanceLocator::enumerate(const json& comp) {
  std::vector<BarrelPlacement> out;
  if (!comp.is_object()) return out;

  std::string comp_name = comp.contains("name") ? read_name(comp["name"]) : "";

  // Composition-level effects: /video/effects
  if (const json* fx = video_effects(comp)) {
    BarrelPlacement base;
    base.scope = PlacementScope::Composition;
    base.comp_name = comp_name;
    scan_effects(*fx, "/video/effects", base, out);
  }

  // Layers → layer-level effects + per-clip effects.
  auto layers = comp.find("layers");
  if (layers != comp.end() && layers->is_array()) {
    for (size_t i = 0; i < layers->size(); i++) {
      const json& layer = (*layers)[i];
      if (!layer.is_object()) continue;
      std::string layer_name = layer.contains("name") ? read_name(layer["name"]) : "";
      std::string lpath = "/layers/" + std::to_string(i);

      if (const json* fx = video_effects(layer)) {
        BarrelPlacement base;
        base.scope = PlacementScope::Layer;
        base.comp_name = comp_name;
        base.layer_name = layer_name;
        base.layer_index = (int)i;
        scan_effects(*fx, lpath + "/video/effects", base, out);
      }

      auto clips = layer.find("clips");
      if (clips != layer.end() && clips->is_array()) {
        for (size_t j = 0; j < clips->size(); j++) {
          const json& clip = (*clips)[j];
          if (!clip.is_object()) continue;
          const json* fx = video_effects(clip);
          if (!fx) continue;
          BarrelPlacement base;
          base.scope = PlacementScope::Clip;
          base.comp_name = comp_name;
          base.layer_name = layer_name;
          base.layer_index = (int)i;
          base.clip_name = clip.contains("name") ? read_name(clip["name"]) : "";
          base.clip_index = (int)j;
          // `connected` is a ParamState whose value tells us if this clip is
          // live ("Connected"/"Previewing") or dormant ("Disconnected"/"Empty").
          if (auto conn = clip.find("connected"); conn != clip.end())
            base.clip_connected = read_name(*conn);
          scan_effects(*fx, lpath + "/clips/" + std::to_string(j) + "/video/effects", base, out);
        }
      }
    }
  }

  // Layer groups (best-effort — the group structure wasn't observed in live
  // captures; if Resolume nests group effects elsewhere this simply finds none).
  auto groups = comp.find("layergroups");
  if (groups != comp.end() && groups->is_array()) {
    for (size_t g = 0; g < groups->size(); g++) {
      const json& group = (*groups)[g];
      if (!group.is_object()) continue;
      const json* fx = video_effects(group);
      if (!fx) continue;
      BarrelPlacement base;
      base.scope = PlacementScope::Group;
      base.comp_name = comp_name;
      base.group_name = group.contains("name") ? read_name(group["name"]) : "";
      base.group_index = (int)g;
      scan_effects(*fx, "/layergroups/" + std::to_string(g) + "/video/effects", base, out);
    }
  }

  return out;
}

bool BarrelPlacement::is_dormant() const {
  // Only clip-mounted barrels can be dormant; a layer/group/composition effect
  // is always live when its host is showing.
  if (scope != PlacementScope::Clip) return false;
  // Live if the clip is Connected or Previewing; dormant otherwise (including
  // Disconnected, Empty, or an absent state).
  return clip_connected.find("Connected") == std::string::npos &&
         clip_connected.find("Previewing") == std::string::npos;
}

std::string InstanceLocator::resolve_uuid(const std::string& config_value) {
  // Marker blobs use the sibling nanoch:// codec (uuid alongside channel/name).
  if (channel_marker::is_marker_config(config_value))
    return channel_marker::uuid_of(config_value);
  // Reads the uuid WITHOUT inflating the (compressed) sketch — this runs on the
  // per-rebroadcast de-dup path, so it must never decompress.
  return barrel_codec::config_uuid(config_value);
}

std::string InstanceLocator::resolve_sketch(const std::string& config_value) {
  std::string decoded = barrel_codec::unwrap_config(config_value);
  if (decoded.empty()) return "";
  json env = json::parse(decoded, nullptr, false);
  if (env.is_discarded() || !env.is_object()) return "";
  auto it = env.find("sketch");
  if (it == env.end()) return "";
  return it->dump();
}

std::string InstanceLocator::default_name_for(const BarrelPlacement& p) {
  switch (p.scope) {
    case PlacementScope::Clip:
      // Clip name only — no "Layer N \xC2\xB7 " prefix. The Instances tab already
      // groups cards into per-track rows under a "Layer N" header (built from
      // placement.track_name, published separately), so the prefix was pure
      // duplication on every card.
      return clip_display(p);
    case PlacementScope::Layer:
      return track_display(p);
    case PlacementScope::Group:
      return group_display(p);
    case PlacementScope::Composition:
      return p.comp_name.empty() ? std::string("Composition") : p.comp_name;
  }
  return "";
}

void InstanceLocator::update(const json& comp, StateDocument& doc,
                             uint64_t now_ms) {
  auto placements = enumerate(comp);

  // The composition is a full snapshot — rebuild the maps from scratch.
  by_path_.clear();
  paths_by_uuid_.clear();
  std::set<int64_t> seen_config_ids;
  for (auto& p : placements) {
    // Resolve the UUID through the change-gated cache: decoding the config blob
    // is expensive for a large sketch, but the UUID is invariant under sketch
    // edits, so we only re-decode when the blob's hash actually changes.
    uint64_t h = fnv1a(p.config_value);
    if (p.config_param_id != 0) {
      seen_config_ids.insert(p.config_param_id);
      auto it = uuid_cache_.find(p.config_param_id);
      if (it != uuid_cache_.end() && it->second.first == h) {
        p.uuid = it->second.second;  // unchanged blob — skip the decode
      } else {
        p.uuid = resolve_uuid(p.config_value);
        uuid_cache_[p.config_param_id] = {h, p.uuid};
      }
    } else {
      p.uuid = resolve_uuid(p.config_value);
    }
    if (!p.uuid.empty()) paths_by_uuid_[p.uuid].insert(p.path);
    by_path_[p.path] = std::move(p);
  }

  // Forget cache entries for config params no longer in the composition.
  for (auto it = uuid_cache_.begin(); it != uuid_cache_.end();) {
    if (seen_config_ids.find(it->first) == seen_config_ids.end())
      it = uuid_cache_.erase(it);
    else
      ++it;
  }

  publish_placements(doc);

  // Publish every NanoBarrel currently in the composition (launched or not —
  // `paths_by_uuid_` comes from a structural scan, independent of plugin
  // registration). `/global/plugins` alone only lists instances that have
  // actually rendered a frame; the web app needs the FULL set for two things:
  //   1. scoping its offline cache to the currently loaded composition, and
  //   2. rendering a labeled read-only placeholder card for a composition-
  //      resident clip Resolume hasn't launched yet.
  // Each entry carries the resolved default display name + composition path —
  // the registered-plugin naming path above (`set_plugin_resolume_info`) can't
  // reach an *unregistered* instance, so a placeholder would otherwise have no
  // human name. Excludes NanoLooper Ch markers (ConfigKind::Marker).
  //
  // `paths_by_uuid_` is a std::map (uuid-ordered), so the array is
  // deterministic; change-gate on the full payload (default_name derives from
  // clip/layer names, which the user can rename) so a rename republishes.
  {
    json barrels = json::array();
    for (auto& [uuid, paths] : paths_by_uuid_) {
      if (uuid.empty() || paths.empty()) continue;
      const BarrelPlacement& p = by_path_.at(*paths.begin());
      if (p.config_kind != ConfigKind::Barrel) continue;
      barrels.push_back({{"uuid", uuid},
                         {"name", default_name_for(p)},
                         {"location", p.path},
                         {"placement", placement_json(p)}});
    }
    if (barrels != last_published_composition_barrels_) {
      doc.set_at("/global/composition_barrel_ids", barrels);
      last_published_composition_barrels_ = barrels;
    }
  }

  // Phase 2: fork dormant copy-paste duplicates.
  detect_and_fork(now_ms);
}

void InstanceLocator::tick(uint64_t now_ms) { detect_and_fork(now_ms); }

void InstanceLocator::publish_placements(StateDocument& doc) {
  // Publish a default display name + placement per resolved UUID. For a UUID at
  // multiple paths (copy-paste), name it from the lexicographically-smallest
  // path so the label stays stable; Phase 2 will fork the duplicate.
  //
  // Deliberately NOT gated on a "last published" cache here. An earlier version
  // kept a uuid -> name map and skipped when the name was unchanged, which broke
  // in two ways: it suppressed the retry for a plugin that registered after the
  // composition scan (see the header — this is what dumped layer-mounted barrels
  // into the web's "Other" row), and it missed placement-only changes that leave
  // the name identical (e.g. reordering a barrel within its effect chain moves
  // `chain_index`). StateDocument::set_plugin_resolume_info already no-ops when
  // the info is byte-identical, so it is the dedup — and it is the one that
  // actually knows whether the plugin is registered.
  for (auto& [uuid, paths] : paths_by_uuid_) {
    if (uuid.empty() || paths.empty()) continue;
    const BarrelPlacement& p = by_path_.at(*paths.begin());
    doc.set_plugin_resolume_info(
        uuid, json{{"default_name", default_name_for(p)},
                   {"location", p.path},
                   {"placement", placement_json(p)}});
    // A false return just means "not registered yet" — the next tick retries.
  }
}

void InstanceLocator::detect_and_fork(uint64_t now_ms) {
  // Forking is opt-in: it needs a real clock and a writer. The naming path
  // in update() runs regardless.
  const bool enabled = now_ms != 0 && (bool)fork_writer_;

  // Prune per-config fork bookkeeping for params that left the composition, so a
  // later re-add can fork again. The set of live config ids comes from the
  // current placement map (so this works on a bare tick with no new comp).
  std::set<int64_t> live_config_ids;
  for (auto& [path, p] : by_path_)
    if (p.config_param_id != 0) live_config_ids.insert(p.config_param_id);
  for (auto it = forked_configs_.begin(); it != forked_configs_.end();) {
    if (live_config_ids.find(it->first) == live_config_ids.end())
      it = forked_configs_.erase(it);
    else
      ++it;
  }

  auto& mint = uuid_minter_;

  for (auto& [uuid, paths] : paths_by_uuid_) {
    if (uuid.empty() || paths.size() < 2) {
      collision_since_.erase(uuid);
      continue;
    }
    if (!enabled) continue;  // record the collision map, but take no action

    // Start (or keep) the dwell clock for this collision.
    uint64_t since = collision_since_.emplace(uuid, now_ms).first->second;
    if (now_ms - since < dwell_ms_) continue;  // let live copies self-heal first

    // Canonical path = a live (non-dormant) copy if any, else the
    // lexicographically-smallest path (stable, matches the naming choice). We
    // keep the canonical and fork the dormant duplicates.
    const std::string* canonical = nullptr;
    for (const std::string& path : paths) {
      const BarrelPlacement& p = by_path_.at(path);
      if (!p.is_dormant()) { canonical = &path; break; }
    }
    if (!canonical) canonical = &*paths.begin();  // sorted set → smallest

    for (const std::string& path : paths) {
      if (&path == canonical || path == *canonical) continue;
      const BarrelPlacement& p = by_path_.at(path);
      // Never rewrite a live plugin's config — the registration-time remint
      // (`uuid-2`) owns that case; our write would just be reverted.
      if (!p.is_dormant()) continue;
      if (p.config_param_id == 0) continue;

      // Skip if we already issued a fork for this exact blob and Resolume hasn't
      // broadcast the write-back yet (blob unchanged).
      uint64_t h = fnv1a(p.config_value);
      auto seen = forked_configs_.find(p.config_param_id);
      if (seen != forked_configs_.end() && seen->second == h) continue;

      // Re-wrap the SAME payload under a fresh uuid and write it over WS. A
      // barrel carries a `sketch`; a marker carries {channel,name} — preserve
      // each so only the identity changes.
      std::string new_uuid = mint ? mint() : random_uuid();
      if (new_uuid.empty()) continue;
      std::string blob;
      if (p.config_kind == ConfigKind::Marker) {
        int ch = channel_marker::channel_of(p.config_value);
        std::string nm = channel_marker::name_of(p.config_value);
        blob = channel_marker::wrap_config(new_uuid, ch >= 1 ? ch : 1, nm);
      } else {
        std::string sketch = resolve_sketch(p.config_value);
        json env = {{"sketch", json::parse(sketch, nullptr, false)}, {"uuid", new_uuid}};
        if (env["sketch"].is_discarded()) env["sketch"] = json::object();
        blob = barrel_codec::wrap_config(env.dump());
      }

      fork_writer_(p.config_param_id, blob);
      forked_configs_[p.config_param_id] = h;
      std::fprintf(stderr,
          "[instance_locator] forked dormant duplicate uuid=%s at %s -> %s "
          "(config id=%lld)\n",
          uuid.c_str(), path.c_str(), new_uuid.c_str(),
          (long long)p.config_param_id);
    }
  }
}

std::optional<BarrelPlacement> InstanceLocator::placement_for_path(
    const std::string& path) const {
  auto it = by_path_.find(path);
  if (it == by_path_.end()) return std::nullopt;
  return it->second;
}

std::set<std::string> InstanceLocator::paths_for_uuid(const std::string& uuid) const {
  auto it = paths_by_uuid_.find(uuid);
  if (it == paths_by_uuid_.end()) return {};
  return it->second;
}

}  // namespace bridge
