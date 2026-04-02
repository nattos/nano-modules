#pragma once

#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "json/json_patch.h"

namespace bridge {

struct PluginMetadata {
  std::string id;    // e.g. "com.nattos.nanolooper"
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

  /// Register a plugin. Returns its key (e.g. "com.nattos.nanolooper@0").
  /// Keys are allocated per plugin type with an incrementing suffix.
  std::string register_plugin(const PluginMetadata& meta);

  /// Declare a parameter on a plugin.
  void declare_param(const std::string& plugin_key, const ParamDecl& param);

  /// Unregister a plugin by key.
  void unregister_plugin(const std::string& key);

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

  /// Drain all pending patches since last call.
  std::vector<json_patch::PatchOp> drain_patches();

private:
  mutable std::mutex mutex_;
  nlohmann::json doc_;
  std::vector<json_patch::PatchOp> pending_;
  std::unordered_map<std::string, int> next_instance_; // per plugin-id counter

  void emit(const std::string& op, const std::string& path,
            const nlohmann::json& value = {});
};

} // namespace bridge
