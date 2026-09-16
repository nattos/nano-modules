// midi_alias.h — control aliases, the native twin of
// web/src/midi/alias-groups.ts (+ collectAliasEdges in wire-lowering.ts).
//
// A sketch wire whose BOTH endpoints are `midi:` control endpoints is an
// ALIAS: the two controls become one logical control. The canonical use is a
// spare controller shadowing the desk in case it dies mid-show, so the rule is
// UNDIRECTED and last-touched-wins:
//
//   - Alias wires are edges of an undirected graph; each connected component
//     is one alias GROUP, and every endpoint in it reads the same value.
//   - That value comes from the member written most recently (the host's
//     monotonic write sequence). A device that dies stops writing, so its
//     stale value loses to the backup's next touch.
//   - A group nobody has touched resolves to nothing, leaving every endpoint
//     unseeded — the executor's dormant-wire contract.
//
// Header-only and dependency-light (nlohmann only, for the sketch scan) so
// both MidiHost and the tests can use it without pulling in CoreMIDI.

#pragma once

#include <algorithm>
#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

namespace nano_midi {

/// One control endpoint: a device library uuid + a full endpoint field
/// ('b0/e05/turn').
struct AliasEndpoint {
  std::string deviceId;
  std::string field;

  bool operator==(const AliasEndpoint& o) const {
    return deviceId == o.deviceId && field == o.field;
  }
  bool operator<(const AliasEndpoint& o) const {
    return deviceId != o.deviceId ? deviceId < o.deviceId : field < o.field;
  }
};

/// One alias wire, reduced to its two endpoints (direction is not semantic).
struct AliasEdge {
  AliasEndpoint a;
  AliasEndpoint b;
};

/// One endpoint's current value plus the host's write sequence for it.
struct AliasSample {
  float value = 0.0f;
  uint64_t seq = 0;
};

/// Table key for an endpoint. NUL-joined: neither half can contain it, so
/// ("a", "b/c") and ("a/b", "c") can never collide. Matches the web's
/// aliasEndpointKey, which is what keeps the tie-break identical.
inline std::string aliasEndpointKey(const std::string& deviceId, const std::string& field) {
  std::string key;
  key.reserve(deviceId.size() + field.size() + 1);
  key += deviceId;
  key.push_back('\0');
  key += field;
  return key;
}

inline std::string aliasEndpointKey(const AliasEndpoint& ep) {
  return aliasEndpointKey(ep.deviceId, ep.field);
}

namespace detail {

/// The `midi:<uuid>` device id of a wire endpoint, or nullopt when the
/// endpoint names a chain instance instead.
inline std::optional<std::string> midiDeviceId(const nlohmann::json& endpoint) {
  if (!endpoint.is_object()) return std::nullopt;
  const std::string key = endpoint.value("instanceKey", std::string());
  if (key.rfind("midi:", 0) != 0) return std::nullopt;
  return key.substr(5);
}

}  // namespace detail

/// Every control alias in one sketch document, deduped by unordered endpoint
/// pair within that sketch. Self-aliases (a control wired to itself) are
/// dropped — they are no-ops that would otherwise widen a group for nothing.
/// Lock-step twin: collectAliasEdges in web/src/midi/wire-lowering.ts.
inline std::vector<AliasEdge> collectAliasEdges(const nlohmann::json& sketch) {
  std::vector<AliasEdge> out;
  auto wit = sketch.find("wires");
  if (wit == sketch.end() || !wit->is_array()) return out;
  std::vector<std::string> seen;
  for (const auto& wire : *wit) {
    if (!wire.is_object()) continue;
    const auto srcId = detail::midiDeviceId(wire.value("src", nlohmann::json::object()));
    const auto dstId = detail::midiDeviceId(wire.value("dest", nlohmann::json::object()));
    if (!srcId || !dstId) continue;
    AliasEndpoint a{*srcId, wire["src"].value("field", std::string())};
    AliasEndpoint b{*dstId, wire["dest"].value("field", std::string())};
    if (a.field.empty() || b.field.empty()) continue;
    if (a == b) continue;
    std::string key = aliasEndpointKey(a < b ? a : b) + '\1' + aliasEndpointKey(a < b ? b : a);
    if (std::find(seen.begin(), seen.end(), key) != seen.end()) continue;
    seen.push_back(std::move(key));
    out.push_back(AliasEdge{std::move(a), std::move(b)});
  }
  return out;
}

/// Connected components over the alias edges — one group per set of controls
/// that must read the same value. Singletons never appear (a group of one is
/// not an alias). Deterministic: members sort by endpoint key and groups by
/// their first member, so the same document always produces the same groups
/// regardless of wire iteration order.
inline std::vector<std::vector<AliasEndpoint>> aliasGroups(const std::vector<AliasEdge>& edges) {
  std::map<std::string, std::string> parent;   // endpoint key → union-find parent
  std::map<std::string, AliasEndpoint> endpoints;

  const auto find = [&parent](std::string k) {
    while (parent[k] != k) k = parent[k];
    return k;
  };
  const auto add = [&](const AliasEndpoint& ep) {
    std::string k = aliasEndpointKey(ep);
    if (!parent.count(k)) { parent[k] = k; endpoints[k] = ep; }
    return k;
  };

  for (const auto& edge : edges) {
    const std::string ka = add(edge.a);
    const std::string kb = add(edge.b);
    if (ka == kb) continue;
    const std::string ra = find(ka), rb = find(kb);
    if (ra == rb) continue;
    // Smaller root wins, so the group's identity doesn't depend on edge order.
    if (ra < rb) parent[rb] = ra; else parent[ra] = rb;
  }

  std::map<std::string, std::vector<AliasEndpoint>> byRoot;
  for (const auto& [k, _] : parent) byRoot[find(k)].push_back(endpoints[k]);

  std::vector<std::vector<AliasEndpoint>> out;
  for (auto& [root, group] : byRoot) {
    (void)root;
    if (group.size() > 1) out.push_back(std::move(group));
  }
  return out;
}

/// The value an alias group resolves to: the most recently written sample
/// among its members. `sample` returns nullopt for an endpoint nobody has
/// touched; when that is every member, the group resolves to nullopt too and
/// its wires stay dormant.
///
/// Ties break on endpoint key so two writes landing in the same host tick
/// still resolve identically on both platforms.
template <typename SampleFn>
inline std::optional<AliasSample> aliasWinner(
    const std::vector<AliasEndpoint>& group, SampleFn&& sample) {
  std::optional<AliasSample> best;
  std::string bestKey;
  for (const auto& ep : group) {
    const std::optional<AliasSample> s = sample(ep);
    if (!s) continue;
    const std::string key = aliasEndpointKey(ep);
    if (!best || s->seq > best->seq || (s->seq == best->seq && key < bestKey)) {
      best = s;
      bestKey = key;
    }
  }
  return best;
}

}  // namespace nano_midi
