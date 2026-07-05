#pragma once

#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

#include <nlohmann/json.hpp>

#include "bridge/platform/mutex.h"
#include "json/json_patch.h"

namespace bridge {

struct PluginMetadata {
  std::string id;    // e.g. "com.nano.nanolooper"
  int major = 0;
  int minor = 0;
  int patch = 0;
};

// FFGL-modeled parameter types
enum ParamType : int {
  PARAM_BOOLEAN  = 0,
  PARAM_EVENT    = 1,
  PARAM_STANDARD = 10,  // float 0-1
  PARAM_OPTION   = 11,
  PARAM_INTEGER  = 13,
  PARAM_TEXT     = 100,
};

struct ParamDecl {
  int index;
  std::string name;
  ParamType type;
  float default_value;
};

// I/O port declarations (texture inputs/outputs, data outputs)
enum IOKind : int {
  IO_TEXTURE_INPUT  = 0,
  IO_TEXTURE_OUTPUT = 1,
  IO_DATA_OUTPUT    = 2,
};

enum IORole : int {
  IO_PRIMARY   = 0,
  IO_SECONDARY = 1,
};

struct IODecl {
  int index;
  std::string name;
  IOKind kind;
  IORole role;
};

struct ConsoleEntry {
  double timestamp = 0;
  std::string level;   // "log", "warn", "error"
  nlohmann::json data;
};

/// The canonical state document for all plugin instances.
/// Thread-safe. Tracks mutations as JSON Patch operations for streaming to clients.
class StateDocument {
public:
  static constexpr int MAX_CONSOLE_ENTRIES = 100;

  StateDocument();

  /// Register a plugin. Returns the key actually registered.
  ///
  /// If `requested_key` is non-empty (e.g. a barrel instance's persisted
  /// UUID), it is used verbatim when free; on collision (a duplicated
  /// instance carrying the same persisted UUID) a unique derivative is
  /// minted and returned instead — callers should compare the returned key
  /// against what they requested and persist the result if it changed.
  /// If `requested_key` is empty, a "<id>@<n>" key is minted from a
  /// per-type incrementing counter (the legacy behavior).
  std::string register_plugin(const PluginMetadata& meta,
                              const std::string& requested_key = "");

  /// Register a plugin with a full schema JSON. Returns the key actually
  /// registered (see register_plugin for `requested_key` semantics).
  /// The schema defines all fields, their types, defaults, and I/O mappings.
  /// Replaces the separate declare_param/declare_io calls.
  std::string register_plugin_with_schema(const PluginMetadata& meta,
                                          const std::string& schema_json,
                                          const std::string& requested_key = "");

  /// Declare a parameter on a plugin (legacy — use register_plugin_with_schema).
  void declare_param(const std::string& plugin_key, const ParamDecl& param);

  /// Declare an I/O port on a plugin (legacy — use register_plugin_with_schema).
  void declare_io(const std::string& plugin_key, const IODecl& io);

  /// Unregister a plugin by key.
  void unregister_plugin(const std::string& key);

  /// Attach Resolume-composition info (e.g. `{default_name, location}`) to a
  /// registered plugin's `/global/plugins[i]` entry, keyed by `key`. Emits a
  /// patch at `/global/plugins/<i>/resolume` only when the value changes.
  /// Returns false if no plugin with `key` is currently registered (the
  /// InstanceLocator re-publishes on a later composition update).
  bool set_plugin_resolume_info(const std::string& key, const nlohmann::json& info);

  /// Append a console log entry (capped at MAX_CONSOLE_ENTRIES).
  void log(const std::string& plugin_key, const ConsoleEntry& entry);

  /// Get a plugin's internal state subtree.
  nlohmann::json get_plugin_state(const std::string& key) const;

  /// Set a plugin's internal state subtree (replaces entirely).
  void set_plugin_state(const std::string& key, const nlohmann::json& state);

  /// Apply client-submitted patches to a plugin's state.
  /// Returns the effective patches (with full paths, for redistribution).
  std::vector<json_patch::PatchOp> apply_client_patch(
      const std::string& plugin_key,
      const std::vector<json_patch::PatchOp>& ops);

  /// Get a snapshot of the full document.
  nlohmann::json document() const;

  /// Get a subtree by JSON Pointer path.
  nlohmann::json get_at(const std::string& path) const;

  /// Set a value at an arbitrary path (creates intermediates as needed).
  void set_at(const std::string& path, const nlohmann::json& value);

  /// Drain all pending patches since last call.
  std::vector<json_patch::PatchOp> drain_patches();

  /// Emit a "dirty" patch notification at `path` without modifying the document.
  /// Used to signal that a GPU array (or other opaque resource) has been
  /// updated in-place and observers should do any lazy reader work.
  void mark_dirty(const std::string& path);

  /// Write a GPU buffer handle (integer) into the state at `path`.
  /// Emits a replace patch only when the handle actually changes.
  /// GPU array fields hold only this handle; their underlying data is not
  /// part of the JSON document.
  void set_gpu_buffer(const std::string& path, int handle);

private:
  mutable platform::Mutex mutex_;
  nlohmann::json doc_;
  std::vector<json_patch::PatchOp> pending_;
  std::unordered_map<std::string, int> next_instance_; // per plugin-id counter
  // plugin_key -> schema JSON (stored object from "fields") — used to
  // strip GPU-resident fields when serializing/diffing plugin state.
  std::unordered_map<std::string, nlohmann::json> plugin_schemas_;

  void emit(const std::string& op, const std::string& path,
            const nlohmann::json& value = {});

  // Resolve the key to register under. Caller must hold mutex_.
  // See register_plugin for the requested_key/collision semantics.
  std::string allocate_key(const std::string& id, const std::string& requested_key);

  // Build initial state by walking the schema recursively.
  nlohmann::json build_initial_state(const nlohmann::json& fields);
  // Collect legacy param declarations from the top-level schema fields.
  void collect_legacy_params(const nlohmann::json& fields, nlohmann::json& params_out);
  // Produce a copy of `state` with GPU array leaves replaced by 0 (for
  // serialization / diffing). `schema_fields` is the object part.
  nlohmann::json strip_gpu_fields(const nlohmann::json& state,
                                   const nlohmann::json& schema_fields) const;
};

} // namespace bridge
