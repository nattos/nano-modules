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
#include <utility>
#include <vector>

namespace sketch_augment {

/**
 * True for schema field type defs eligible for an IMPLICIT struct rail:
 * composites only — `object` and `array`.
 *
 * Vectors (`float2/3/4`) are deliberately excluded, though they are
 * "structured" in every other sense (the editor gives them a port widget
 * rather than a slider, and `isRailCompatible` transports them happily on an
 * explicit wire). The implicit rule is POSITIONAL — "nearest compatible
 * producer above" — and that is only safe when a match means something. A
 * composite's shape is specific: a particles buffer matches a particles
 * consumer and nothing else. A bare `float3` matches every other `float3` in
 * the tree — a tint, a gradient stop, a position, a scale — so the rule would
 * connect fields that merely share an arity.
 *
 * This was latent rather than theoretical: vecs were listed here from the
 * start, and stayed inert only because nothing in the tree published one.
 * `mod.source.color` became the first vec producer and the rule started
 * firing — synthesising a rail plus both taps that then carried NOTHING,
 * because a struct rail transports its scalar/texture/buffer leaves and
 * `collectScalarLeaves` has no float3 case. A port that reads as connected
 * and moves no value is worse than either honest answer.
 *
 * Colour crosses a wire the user drew, as a `vec` rail (see the `float2/3/4`
 * branch of rail lowering in sketch_executor.cpp).
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
 * chain entries (eg "color.tone.brightness_contrast") to the schema's
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

/**
 * Like collectTextureLeaves, but for GPU storage-buffer leaves
 * (`type:array` with `gpu:true`). Used when routing a struct rail that
 * carries GPU-resident arrays (e.g. particle positions/velocities).
 */
void collectGpuBufferLeaves(const nlohmann::json& schema,
                            const std::string& prefix,
                            std::vector<std::string>& out);

/**
 * Like collectTextureLeaves, but for scalar leaves (`type` in
 * int/float/bool). Yields each leaf path paired with its schema
 * `default` (0 when absent). A struct rail flows these from the
 * producer's output declaration to the consumer's input.
 */
void collectScalarLeaves(const nlohmann::json& schema,
                         const std::string& prefix,
                         std::vector<std::pair<std::string, double>>& out);

}  // namespace sketch_augment
