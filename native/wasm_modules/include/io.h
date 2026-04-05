#pragma once
/*
 * io.h — C++ wrappers for the io.* host API.
 *
 * Declares a module's I/O profile: texture inputs/outputs, data outputs.
 * Each port has an index, name, kind, and role (primary/secondary).
 * Primary ports are exposed to the FFGL host; secondary are bridge-only.
 *
 * Usage:
 *   io::declareTextureInput(0, "Input", io::Role::Primary);
 *   io::declareTextureOutput(0, "Output", io::Role::Primary);
 *   io::declareDataOutput(0, "Debug", io::Role::Secondary);
 */

#include <cstring>

extern "C" {
  __attribute__((import_module("io"), import_name("declare_texture_input")))
  void io_declare_texture_input(int index, const char* name, int name_len, int role);
  __attribute__((import_module("io"), import_name("declare_texture_output")))
  void io_declare_texture_output(int index, const char* name, int name_len, int role);
  __attribute__((import_module("io"), import_name("declare_data_output")))
  void io_declare_data_output(int index, const char* name, int name_len, int role);
}

namespace io {

enum class Role : int { Primary = 0, Secondary = 1 };

inline void declareTextureInput(int index, const char* name, Role role = Role::Primary) {
  io_declare_texture_input(index, name, std::strlen(name), static_cast<int>(role));
}

inline void declareTextureOutput(int index, const char* name, Role role = Role::Primary) {
  io_declare_texture_output(index, name, std::strlen(name), static_cast<int>(role));
}

inline void declareDataOutput(int index, const char* name, Role role = Role::Secondary) {
  io_declare_data_output(index, name, std::strlen(name), static_cast<int>(role));
}

} // namespace io
