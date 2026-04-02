#include "json/json_patch.h"

#include <algorithm>

using json = nlohmann::json;

namespace json_patch {

// --- RFC 6901 JSON Pointer parsing ---

// Unescape a JSON Pointer token: ~1 → /, ~0 → ~
static std::string unescape_token(const std::string& token) {
  std::string result;
  result.reserve(token.size());
  for (size_t i = 0; i < token.size(); i++) {
    if (token[i] == '~' && i + 1 < token.size()) {
      if (token[i + 1] == '1') { result += '/'; i++; continue; }
      if (token[i + 1] == '0') { result += '~'; i++; continue; }
    }
    result += token[i];
  }
  return result;
}

// Split a JSON Pointer path into tokens.
// "" → empty vector (root), "/foo/bar" → ["foo", "bar"]
static std::vector<std::string> split_pointer(const std::string& path) {
  if (path.empty()) return {};
  // Must start with /
  if (path[0] != '/') return {};

  std::vector<std::string> tokens;
  size_t pos = 1;
  while (pos <= path.size()) {
    size_t next = path.find('/', pos);
    if (next == std::string::npos) next = path.size();
    tokens.push_back(unescape_token(path.substr(pos, next - pos)));
    pos = next + 1;
  }
  return tokens;
}

// Escape a string for use as a JSON Pointer token
static std::string escape_token(const std::string& token) {
  std::string result;
  for (char c : token) {
    if (c == '~') result += "~0";
    else if (c == '/') result += "~1";
    else result += c;
  }
  return result;
}

// --- Pointer resolution ---

json* resolve_pointer(json& doc, const std::string& path) {
  if (path.empty()) return &doc;
  auto tokens = split_pointer(path);
  if (tokens.empty() && !path.empty()) return nullptr; // invalid pointer

  json* current = &doc;
  for (const auto& token : tokens) {
    if (current->is_object()) {
      auto it = current->find(token);
      if (it == current->end()) return nullptr;
      current = &(*it);
    } else if (current->is_array()) {
      if (token == "-") return nullptr; // can't resolve "past the end"
      try {
        size_t idx = std::stoul(token);
        if (idx >= current->size()) return nullptr;
        current = &(*current)[idx];
      } catch (...) { return nullptr; }
    } else {
      return nullptr;
    }
  }
  return current;
}

const json* resolve_pointer(const json& doc, const std::string& path) {
  return resolve_pointer(const_cast<json&>(doc), path);
}

// Get parent and last token from a path. Returns false if path is root.
static bool split_parent(const std::string& path, std::string& parent_path, std::string& last_token) {
  if (path.empty()) return false;
  auto last_slash = path.rfind('/');
  if (last_slash == std::string::npos) return false;
  parent_path = path.substr(0, last_slash);
  if (parent_path.empty()) parent_path = ""; // root
  last_token = unescape_token(path.substr(last_slash + 1));
  return true;
}

// --- Apply operations ---

bool apply_op(json& doc, const PatchOp& op) {
  if (op.op == "add") {
    if (op.path.empty()) {
      doc = op.value;
      return true;
    }
    std::string parent_path, key;
    if (!split_parent(op.path, parent_path, key)) return false;
    json* parent = resolve_pointer(doc, parent_path);
    if (!parent) return false;
    if (parent->is_object()) {
      (*parent)[key] = op.value;
      return true;
    }
    if (parent->is_array()) {
      if (key == "-") {
        parent->push_back(op.value);
        return true;
      }
      try {
        size_t idx = std::stoul(key);
        if (idx > parent->size()) return false;
        parent->insert(parent->begin() + idx, op.value);
        return true;
      } catch (...) { return false; }
    }
    return false;
  }

  if (op.op == "remove") {
    if (op.path.empty()) return false; // can't remove root
    std::string parent_path, key;
    if (!split_parent(op.path, parent_path, key)) return false;
    json* parent = resolve_pointer(doc, parent_path);
    if (!parent) return false;
    if (parent->is_object()) {
      auto it = parent->find(key);
      if (it == parent->end()) return false;
      parent->erase(it);
      return true;
    }
    if (parent->is_array()) {
      try {
        size_t idx = std::stoul(key);
        if (idx >= parent->size()) return false;
        parent->erase(parent->begin() + idx);
        return true;
      } catch (...) { return false; }
    }
    return false;
  }

  if (op.op == "replace") {
    json* target = resolve_pointer(doc, op.path);
    if (!target) return false;
    *target = op.value;
    return true;
  }

  if (op.op == "test") {
    const json* target = resolve_pointer(doc, op.path);
    if (!target) return false;
    return *target == op.value;
  }

  if (op.op == "move") {
    const json* src = resolve_pointer(doc, op.from);
    if (!src) return false;
    json val = *src; // copy before removing
    PatchOp remove_op{"remove", op.from, {}, {}};
    if (!apply_op(doc, remove_op)) return false;
    PatchOp add_op{"add", op.path, std::move(val), {}};
    return apply_op(doc, add_op);
  }

  if (op.op == "copy") {
    const json* src = resolve_pointer(doc, op.from);
    if (!src) return false;
    PatchOp add_op{"add", op.path, *src, {}};
    return apply_op(doc, add_op);
  }

  return false; // unknown op
}

bool apply_patch(json& doc, const std::vector<PatchOp>& ops) {
  for (const auto& op : ops) {
    if (!apply_op(doc, op)) return false;
  }
  return true;
}

// --- Parse / Serialize ---

std::vector<PatchOp> parse_patch(const json& patch_array) {
  std::vector<PatchOp> ops;
  if (!patch_array.is_array()) return ops;
  for (const auto& item : patch_array) {
    PatchOp op;
    if (item.contains("op")) op.op = item["op"].get<std::string>();
    if (item.contains("path")) op.path = item["path"].get<std::string>();
    if (item.contains("value")) op.value = item["value"];
    if (item.contains("from")) op.from = item["from"].get<std::string>();
    ops.push_back(std::move(op));
  }
  return ops;
}

json serialize_patch(const std::vector<PatchOp>& ops) {
  json arr = json::array();
  for (const auto& op : ops) {
    json item;
    item["op"] = op.op;
    item["path"] = op.path;
    if (op.op == "add" || op.op == "replace" || op.op == "test") {
      item["value"] = op.value;
    }
    if (op.op == "move" || op.op == "copy") {
      item["from"] = op.from;
    }
    arr.push_back(std::move(item));
  }
  return arr;
}

// --- Diff ---

static void diff_recursive(const json& before, const json& after,
                            const std::string& path, std::vector<PatchOp>& ops) {
  if (before == after) return;

  if (before.type() != after.type()) {
    ops.push_back({"replace", path, after, {}});
    return;
  }

  if (before.is_object()) {
    // Removed keys
    for (auto it = before.begin(); it != before.end(); ++it) {
      if (!after.contains(it.key())) {
        ops.push_back({"remove", path + "/" + escape_token(it.key()), {}, {}});
      }
    }
    // Added or changed keys
    for (auto it = after.begin(); it != after.end(); ++it) {
      std::string child_path = path + "/" + escape_token(it.key());
      if (!before.contains(it.key())) {
        ops.push_back({"add", child_path, it.value(), {}});
      } else {
        diff_recursive(before[it.key()], it.value(), child_path, ops);
      }
    }
    return;
  }

  if (before.is_array()) {
    // Simple approach: if arrays differ, replace entirely.
    // A more sophisticated diff could compute minimal edits, but for our
    // use case (console logs, state arrays) replace is sufficient.
    ops.push_back({"replace", path, after, {}});
    return;
  }

  // Scalar types
  ops.push_back({"replace", path, after, {}});
}

std::vector<PatchOp> diff(const json& before, const json& after) {
  std::vector<PatchOp> ops;
  diff_recursive(before, after, "", ops);
  return ops;
}

} // namespace json_patch
