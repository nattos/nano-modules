#include "sketch/sketch_augment.h"

#include <string>
#include <unordered_map>
#include <vector>

namespace sketch_augment {

using nlohmann::json;

bool isStructuredSchemaTypeDef(const json& def) {
  if (!def.is_object()) return false;
  std::string type = def.value("type", std::string());
  return type == "object" || type == "array"
      || type == "float2"  || type == "float3" || type == "float4";
}

// ----- Compatibility check (port of schema-compat.ts) ----------------

static std::string nodeCompat(const json& writer, const json& reader,
                              const std::string& path);

bool isRailCompatible(const json& writer, const json& reader) {
  return nodeCompat(writer, reader, "").empty();
}

static std::string nodeCompat(const json& writer, const json& reader,
                              const std::string& path) {
  if (!writer.is_object() || !reader.is_object()) {
    return (path.empty() ? "<root>" : path) + ": missing schema";
  }
  const std::string wt = writer.value("type", std::string());
  const std::string rt = reader.value("type", std::string());
  if (wt != rt) {
    return (path.empty() ? "<root>" : path) + ": type mismatch";
  }
  // Primitive/scalar/texture/vec leaves — same type passes.
  if (wt == "float"  || wt == "int"    || wt == "bool"   || wt == "string" ||
      wt == "event"  || wt == "texture" ||
      wt == "float2" || wt == "float3" || wt == "float4") {
    return "";
  }
  if (wt == "array") {
    const bool wgpu = writer.value("gpu", false);
    const bool rgpu = reader.value("gpu", false);
    if (wgpu != rgpu) return path + ": gpu flag mismatch";
    if (writer.contains("elementType") || reader.contains("elementType")) {
      return nodeCompat(writer.value("elementType", json::object()),
                        reader.value("elementType", json::object()),
                        path + "[]");
    }
    return "";
  }
  if (wt == "object") {
    const auto& wf = writer.value("fields", json::object());
    const auto& rf = reader.value("fields", json::object());
    for (auto it = rf.begin(); it != rf.end(); ++it) {
      if (!wf.contains(it.key())) {
        return path + "/" + it.key() + ": missing on writer";
      }
      auto err = nodeCompat(wf[it.key()], it.value(),
                            path + "/" + it.key());
      if (!err.empty()) return err;
    }
    // Strict: extra writer fields disallowed (no allowExtra in barrel
    // path — the original TS sketch-executor calls without that opt too).
    for (auto it = wf.begin(); it != wf.end(); ++it) {
      if (!rf.contains(it.key())) {
        return path + "/" + it.key() + ": extra field on writer";
      }
    }
    return "";
  }
  // Unknown type → pass (future-proofing, matches TS).
  return "";
}

// ----- Texture-leaf collection --------------------------------------

void collectTextureLeaves(const json& schema,
                          const std::string& prefix,
                          std::vector<std::string>& out) {
  if (!schema.is_object()) return;
  const std::string type = schema.value("type", std::string());
  if (type == "texture") {
    out.push_back(prefix);
    return;
  }
  if (type == "object") {
    const auto& fields = schema.value("fields", json::object());
    if (!fields.is_object()) return;
    for (auto it = fields.begin(); it != fields.end(); ++it) {
      const std::string child = prefix.empty()
                                    ? it.key()
                                    : (prefix + "/" + it.key());
      collectTextureLeaves(it.value(), child, out);
    }
  }
}

void collectGpuBufferLeaves(const json& schema,
                            const std::string& prefix,
                            std::vector<std::string>& out) {
  if (!schema.is_object()) return;
  const std::string type = schema.value("type", std::string());
  if (type == "array" && schema.value("gpu", false)) {
    out.push_back(prefix);
    return;
  }
  if (type == "object") {
    const auto& fields = schema.value("fields", json::object());
    if (!fields.is_object()) return;
    for (auto it = fields.begin(); it != fields.end(); ++it) {
      const std::string child = prefix.empty()
                                    ? it.key()
                                    : (prefix + "/" + it.key());
      collectGpuBufferLeaves(it.value(), child, out);
    }
  }
}

void collectScalarLeaves(const json& schema,
                         const std::string& prefix,
                         std::vector<std::pair<std::string, double>>& out) {
  if (!schema.is_object()) return;
  const std::string type = schema.value("type", std::string());
  if (type == "int" || type == "float" || type == "bool") {
    double def = 0.0;
    auto dit = schema.find("default");
    if (dit != schema.end()) {
      if (dit->is_number())       def = dit->get<double>();
      else if (dit->is_boolean()) def = dit->get<bool>() ? 1.0 : 0.0;
    }
    out.emplace_back(prefix, def);
    return;
  }
  if (type == "object") {
    const auto& fields = schema.value("fields", json::object());
    if (!fields.is_object()) return;
    for (auto it = fields.begin(); it != fields.end(); ++it) {
      const std::string child = prefix.empty()
                                    ? it.key()
                                    : (prefix + "/" + it.key());
      collectScalarLeaves(it.value(), child, out);
    }
  }
}

// ----- Augmentation -------------------------------------------------

namespace {

struct WriteTapInfo {
  std::string railId;
  json        dataType;
};

void augmentColumn(json& sketch, int colIdx,
                   const std::unordered_map<std::string, json>& schemas) {
  if (!sketch.contains("columns")) return;
  auto& column = sketch["columns"][colIdx];
  if (!column.contains("chain") || !column["chain"].is_array()) return;
  auto& chain = column["chain"];

  // Deterministic implicit-rail IDs — repeated augmentations of the
  // same input produce identical output.
  auto implicitRailId = [colIdx](int producerChainIdx,
                                 const std::string& producerFieldPath) {
    return "__implicit__/" + std::to_string(colIdx) + "/" +
           std::to_string(producerChainIdx) + "/" + producerFieldPath;
  };

  // Combined rail list (column-local + sketch-wide) for lookup-by-id.
  json allRails = json::array();
  if (column.contains("rails") && column["rails"].is_array()) {
    for (const auto& r : column["rails"]) allRails.push_back(r);
  }
  if (sketch.contains("rails") && sketch["rails"].is_array()) {
    for (const auto& r : sketch["rails"]) allRails.push_back(r);
  }

  // Index existing explicit write taps by "producerChainIdx/fieldPath"
  // — consumers can reuse whatever rail a producer is already writing.
  std::unordered_map<std::string, WriteTapInfo> writeTapByProducer;
  for (size_t i = 0; i < chain.size(); ++i) {
    const auto& e = chain[i];
    if (!e.is_object() || e.value("type", std::string()) != "module") continue;
    if (!e.contains("taps") || !e["taps"].is_array()) continue;
    for (const auto& t : e["taps"]) {
      if (t.value("direction", std::string()) != "write") continue;
      const std::string railId = t.value("railId", std::string());
      for (const auto& r : allRails) {
        if (r.value("id", std::string()) == railId) {
          WriteTapInfo info{railId, r.value("dataType", json())};
          writeTapByProducer[std::to_string(i) + "/" +
                             t.value("fieldPath", std::string())] = info;
          break;
        }
      }
    }
  }

  for (size_t i = 0; i < chain.size(); ++i) {
    auto& entry = chain[i];
    if (!entry.is_object() || entry.value("type", std::string()) != "module") continue;
    const std::string moduleType = entry.value("module_type", std::string());
    auto schemaIt = schemas.find(moduleType);
    if (schemaIt == schemas.end()) continue;
    const json& schema = schemaIt->second;
    if (!schema.is_object()) continue;

    for (auto fit = schema.begin(); fit != schema.end(); ++fit) {
      const std::string& fieldName = fit.key();
      const json& def = fit.value();
      if (!def.is_object()) continue;
      const int io = def.value("io", 0);
      if (!(io & 1)) continue;                    // not an input
      if (!isStructuredSchemaTypeDef(def)) continue;

      // Skip if user already has an explicit read tap on this field.
      bool hasRead = false;
      if (entry.contains("taps") && entry["taps"].is_array()) {
        for (const auto& t : entry["taps"]) {
          if (t.value("fieldPath", std::string()) == fieldName &&
              t.value("direction", std::string()) == "read") {
            hasRead = true; break;
          }
        }
      }
      if (hasRead) continue;

      // Walk earlier modules for a compatible structured output.
      int producerChainIdx = -1;
      std::string producerFieldPath;
      json producerSchema;
      for (int j = static_cast<int>(i) - 1; j >= 0 && producerChainIdx < 0; --j) {
        const auto& pe = chain[j];
        if (!pe.is_object() || pe.value("type", std::string()) != "module") continue;
        const std::string pmt = pe.value("module_type", std::string());
        auto pschemaIt = schemas.find(pmt);
        if (pschemaIt == schemas.end()) continue;
        const json& pschema = pschemaIt->second;
        if (!pschema.is_object()) continue;
        for (auto pit = pschema.begin(); pit != pschema.end(); ++pit) {
          const json& pdef = pit.value();
          if (!pdef.is_object()) continue;
          const int pio = pdef.value("io", 0);
          if (!(pio & 2)) continue;
          if (!isStructuredSchemaTypeDef(pdef)) continue;
          if (!isRailCompatible(pdef, def)) continue;
          producerChainIdx = j;
          producerFieldPath = pit.key();
          producerSchema = pdef;
          break;
        }
      }
      if (producerChainIdx < 0) continue;

      // Reuse an existing write-tap'd rail if compatible, else synth a
      // new implicit rail + write tap on the producer.
      const std::string producerKey = std::to_string(producerChainIdx) + "/" +
                                       producerFieldPath;
      WriteTapInfo produced;
      auto producedIt = writeTapByProducer.find(producerKey);
      if (producedIt == writeTapByProducer.end()) {
        const std::string railId =
            implicitRailId(producerChainIdx, producerFieldPath);
        json dataType = {
          {"kind", "struct"},
          {"schema", producerSchema},
        };
        if (!column.contains("rails") || !column["rails"].is_array()) {
          column["rails"] = json::array();
        }
        column["rails"].push_back({
          {"id", railId},
          {"name", railId},
          {"dataType", dataType},
        });

        auto& producerEntry = chain[producerChainIdx];
        if (!producerEntry.contains("taps") || !producerEntry["taps"].is_array()) {
          producerEntry["taps"] = json::array();
        }
        producerEntry["taps"].push_back({
          {"railId", railId},
          {"fieldPath", producerFieldPath},
          {"direction", "write"},
        });

        produced.railId = railId;
        produced.dataType = dataType;
        writeTapByProducer[producerKey] = produced;
      } else {
        produced = producedIt->second;
        // Sanity (parallels the TS): if the producer's existing rail
        // isn't structurally compatible with this consumer, skip.
        if (produced.dataType.is_object() &&
            produced.dataType.value("kind", std::string()) == "struct") {
          const auto& dts = produced.dataType.value("schema", json());
          if (!isRailCompatible(dts, def)) continue;
        }
      }

      if (!entry.contains("taps") || !entry["taps"].is_array()) {
        entry["taps"] = json::array();
      }
      entry["taps"].push_back({
        {"railId", produced.railId},
        {"fieldPath", fieldName},
        {"direction", "read"},
      });
    }
  }
}

}  // namespace

json augmentSketchWithImplicitConnections(
    const json& sketch,
    const std::unordered_map<std::string, json>& pluginSchemas) {
  // Deep-clone so the caller's sketch is untouched.
  json clone = sketch;
  if (!clone.contains("columns") || !clone["columns"].is_array()) return clone;
  for (size_t i = 0; i < clone["columns"].size(); ++i) {
    augmentColumn(clone, static_cast<int>(i), pluginSchemas);
  }
  return clone;
}

bool sketchNeedsAugmentation(
    const json& sketch,
    const std::unordered_map<std::string, json>& pluginSchemas) {
  if (!sketch.is_object() || !sketch.contains("columns")) return false;
  const auto& columns = sketch["columns"];
  if (!columns.is_array()) return false;
  for (const auto& col : columns) {
    if (!col.is_object() || !col.contains("chain")) continue;
    const auto& chain = col["chain"];
    if (!chain.is_array()) continue;
    for (const auto& entry : chain) {
      if (!entry.is_object()) continue;
      const auto mtIt = entry.find("module_type");
      if (mtIt == entry.end() || !mtIt->is_string()) continue;
      const auto schemaIt = pluginSchemas.find(mtIt->get<std::string>());
      if (schemaIt == pluginSchemas.end()) continue;
      const auto& fields = schemaIt->second;
      if (!fields.is_object()) continue;
      for (auto fIt = fields.begin(); fIt != fields.end(); ++fIt) {
        if (isStructuredSchemaTypeDef(fIt.value())) return true;
      }
    }
  }
  return false;
}

}  // namespace sketch_augment
