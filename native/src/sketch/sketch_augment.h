// sketch_augment.h — shared sketch-render preparation.
//
// The sketch the editor stores (and the bridge persists) is the "raw"
// graph: the modules the user explicitly placed, plus any rails/taps
// they wired by hand. Before the graph can be rendered, structured
// inputs that haven't been explicitly connected need implicit rails
// synthesised so producer's outputs flow to consumer's inputs.
//
// This logic is **render-time preparation**, not a UI concern. It must
// live in shared code so every renderer (the native FFGL barrel
// plugin, the web engine-worker via the wasm-compiled bridge, any
// future host) consumes the same augmented graph.
//
// Port of `augmentSketchWithImplicitConnections` from
// web/src/state/controller.ts; one-for-one semantics with the matching
// helpers in web/src/schema-compat.ts. The TS version still lives in
// the editor today but should be replaced by a wasm-bound call into
// this library — that work is editor-side, separate from the barrel.

#pragma once

#include <nlohmann/json.hpp>
#include <string>
#include <unordered_map>

namespace sketch_augment {

/**
 * True for schema field type defs that need struct-rail transport
 * (anything that isn't a primitive scalar / texture leaf). Mirrors
 * `isStructuredSchemaTypeDef` in controller.ts.
 */
bool isStructuredSchemaTypeDef(const nlohmann::json& def);

/**
 * Shape-by-shape compatibility check between a writer's and reader's
 * schema subtrees. Producer is assignable to consumer iff their
 * structures match recursively — same field names, same leaf types.
 * Mirrors `isRailCompatible` in schema-compat.ts. Returns true on
 * compat, false otherwise.
 */
bool isRailCompatible(const nlohmann::json& writer,
                      const nlohmann::json& reader);

/**
 * Produce a copy of `sketch` with synthesised implicit rails + taps
 * added. Original sketch is not mutated.
 *
 * `pluginSchemas` maps the module_type string used in the sketch's
 * chain entries (eg "video.brightness_contrast") to the schema's
 * fields object — same shape the editor's `PluginInfo.schema` holds.
 *
 * Algorithm per column: for each module's structured input that has
 * no explicit read tap, find the nearest earlier module with a
 * compatible structured output, synthesise an implicit rail (or reuse
 * an existing write tap) and add the read tap. Synthetic rail IDs are
 * deterministic — `__implicit__/<col>/<producerChainIdx>/<fieldPath>` —
 * so repeated augmentations of the same input produce identical
 * output.
 */
nlohmann::json augmentSketchWithImplicitConnections(
    const nlohmann::json& sketch,
    const std::unordered_map<std::string, nlohmann::json>& pluginSchemas);

/**
 * Cheap pre-check that returns true iff any chain entry in `sketch`
 * uses a module whose schema contains at least one structured field
 * (object/array/vecN). The full augmentation pass only ever inserts
 * taps for structured I/O, so when this returns false the executor
 * can skip the deep clone + per-column walk entirely.
 *
 * Conservative — returns true for any module that COULD be augmented,
 * even when every consumer already has an explicit read tap. The
 * actual augmenter is a no-op in that case; we just don't fast-path
 * around it. The hot case is "every chain is texture-only" (eg a long
 * chain of brightness_contrast / saturate / etc.), which we do
 * skip.
 */
bool sketchNeedsAugmentation(
    const nlohmann::json& sketch,
    const std::unordered_map<std::string, nlohmann::json>& pluginSchemas);

/**
 * Walk a JSON schema subtree and append every texture-leaf path
 * (slash-separated, relative to `prefix`) to `out`. Recursively
 * descends `type:object` fields. Used by the executor when routing a
 * struct rail — it tells you which leaves under a tap's `fieldPath`
 * carry textures.
 */
void collectTextureLeaves(const nlohmann::json& schema,
                          const std::string& prefix,
                          std::vector<std::string>& out);

}  // namespace sketch_augment
