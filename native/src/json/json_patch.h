#pragma once

#include <string>
#include <vector>

#include <nlohmann/json.hpp>

namespace json_patch {

struct PatchOp {
  std::string op;     // "add", "remove", "replace", "move", "copy", "test"
  std::string path;   // JSON Pointer (RFC 6901)
  nlohmann::json value;  // for add/replace/test
  std::string from;   // for move/copy
};

/// Resolve a JSON Pointer path to a reference within a document.
/// Returns nullptr if the path doesn't exist.
nlohmann::json* resolve_pointer(nlohmann::json& doc, const std::string& path);
const nlohmann::json* resolve_pointer(const nlohmann::json& doc, const std::string& path);

/// Apply a single patch operation. Returns true on success.
bool apply_op(nlohmann::json& doc, const PatchOp& op);

/// Apply a list of patch operations. Returns true if all succeeded.
/// On failure, the document may be partially modified.
bool apply_patch(nlohmann::json& doc, const std::vector<PatchOp>& ops);

/// Parse a JSON Patch array (RFC 6902 format) into PatchOp structs.
std::vector<PatchOp> parse_patch(const nlohmann::json& patch_array);

/// Serialize patch operations to a JSON Patch array.
nlohmann::json serialize_patch(const std::vector<PatchOp>& ops);

/// Compute the diff between two documents as a list of patch operations.
/// Applying the result to `before` produces `after`.
std::vector<PatchOp> diff(const nlohmann::json& before, const nlohmann::json& after);

} // namespace json_patch
