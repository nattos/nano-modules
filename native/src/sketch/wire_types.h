#pragma once
/*
 * wire_types.h — resolving a wire's CONCRETE data class through `any` fields.
 *
 * A schema is published once per module TYPE (module_init takes no `self`), so
 * a node whose port type varies per card — a switch whose cases carry floats on
 * one card and textures on the next — cannot declare that type in its schema.
 * `anyField` (host.h) declares the port polymorphic instead, and this walks the
 * wire graph backwards to whatever concrete type is actually feeding it.
 *
 * The resolution happens ONCE, during rail lowering (a structural, dirty-frame
 * path whose result is cached in the exec doc), and the rail records the
 * concrete type. Nothing downstream — applyReadTaps, captureWriteTaps, the
 * forEachRailLeaf* walks, the delayed maps — ever sees `any`. That is what makes
 * polymorphic ports cheap: the per-frame path is untouched.
 *
 * LOCK-STEP TWIN: web/src/state/schema-channels.ts's `resolveWireKind`. The
 * editor decides what to draw and what to allow; the executor decides what to
 * build. If the two rules disagree the editor shows a connection the engine
 * dropped, or refuses one it would have made. This lives in its own header (the
 * shape sketch_canvas::resolveExecOrder uses) so both the executor and the
 * shared-fixture test drive the SAME code.
 */

#include <algorithm>
#include <functional>
#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

namespace wire_types {

/// Look up a chain instance's schema FIELDS object by instance key. Returns
/// nullptr for an unknown key (an external `midi:` source, or a dangling wire).
using SchemaFn = std::function<const nlohmann::json*(const std::string&)>;

/// Maximum hops through chained `any` nodes before giving up. Also the cycle
/// guard: a wire loop through polymorphic ports would otherwise recurse forever.
/// Matches `resolvePolarity`'s guard, and the TS twin's.
inline constexpr int kMaxDepth = 16;

/**
 * The resolved producer field DEF behind `key`.`field`.
 *
 * Returns the field's own def when it declares a concrete type. When it is
 * `any`, returns the def of whatever is wired to this node's own `any` INPUTS —
 * recursively, so `any` nodes chain. Returns null json when unresolvable:
 * nothing wired behind the `any` yet, an unknown key, or the depth guard
 * tripping. The caller drops such a wire, exactly as it drops any other
 * unsupported type.
 *
 * The DEF is returned rather than just the type name because callers need more
 * than the tag: a struct rail carries the def as its leaf schema, and a float
 * rail reads its declared range for the editor's modulation band.
 *
 * TIE-BREAK, when a node's `any` inputs resolve to different types: the
 * LOWEST-numbered wired input wins — "case 1 picks the type", ordered by the
 * schema's `order` key then name. Deliberately NOT a type-precedence table: this
 * rule is duplicated across the C++/TS boundary, and a shared ordering would be
 * a second thing to keep in sync — the exact shape of bug that has bitten this
 * codebase before (the alphabetical-params drift). One comparison per language,
 * and it stays stable as new types are added.
 */
inline nlohmann::json resolveWireDef(const SchemaFn& schemaFor,
                                     const nlohmann::json& wires,
                                     const std::string& key,
                                     const std::string& field,
                                     int depth = 0) {
  using nlohmann::json;
  if (depth > kMaxDepth) return json();
  // An external device control has no chain entry; those rails are always float
  // 0..1 (the executor's external-rail branch), so an `any` input driven by a
  // MIDI surface resolves instead of dying at the schema lookup.
  if (key.rfind("midi:", 0) == 0)
    return json{{"type", "float"}, {"min", 0.0}, {"max", 1.0}};

  const json* fields = schemaFor(key);
  if (!fields || !fields->is_object()) return json();
  auto fit = fields->find(field);
  if (fit == fields->end() || !fit->is_object()) return json();
  if (fit->value("type", std::string()) != "any") return *fit;   // concrete

  // Polymorphic: this node's own `any` INPUTS decide, in declaration order.
  std::vector<std::pair<int, std::string>> ins;
  for (auto it = fields->begin(); it != fields->end(); ++it) {
    const json& d = it.value();
    if (!d.is_object()) continue;
    if (d.value("type", std::string()) != "any") continue;
    if (!(d.value("io", 0) & 1)) continue;              // Input bit
    ins.emplace_back(d.value("order", 1 << 20), it.key());
  }
  std::sort(ins.begin(), ins.end());

  if (!wires.is_array()) return json();
  for (const auto& in : ins) {
    for (const auto& w : wires) {
      if (!w.is_object()) continue;
      const json d = w.value("dest", json::object());
      if (d.value("instanceKey", std::string()) != key) continue;
      if (d.value("field", std::string()) != in.second) continue;
      const json s = w.value("src", json::object());
      json sub = resolveWireDef(schemaFor, wires,
                                s.value("instanceKey", std::string()),
                                s.value("field", std::string()), depth + 1);
      // First RESOLVED input wins — an input wired to something itself
      // unresolvable doesn't veto the ones after it.
      if (sub.is_object()) return sub;
    }
  }
  return json();                                        // nothing wired → unknown
}

/// Convenience: just the type tag ("float" / "texture" / "object" / ...), or ""
/// when unresolvable.
inline std::string resolveWireType(const SchemaFn& schemaFor,
                                   const nlohmann::json& wires,
                                   const std::string& key,
                                   const std::string& field) {
  const nlohmann::json def = resolveWireDef(schemaFor, wires, key, field, 0);
  return def.is_object() ? def.value("type", std::string()) : std::string();
}

}  // namespace wire_types
