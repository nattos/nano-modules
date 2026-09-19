#pragma once

// A fresh random UUID, formatted the way NSUUID prints one:
// uppercase hex, 8-4-4-4-12, e.g. "3F2504E0-4F89-41D3-9A0C-0305E82C3301".
//
// The format is load-bearing, not cosmetic. A barrel's UUID is its persisted
// identity — it goes into the FFGL config blob, into the shared state
// document's key, and into the effect-instance namespace — so an instance
// minted by one build has to look identical to one minted by another, or a
// composition saved before this header existed stops matching itself.

#include <string>

#ifdef _WIN32
#include <rpc.h>
#include <cstdio>
#else
#include <CoreFoundation/CoreFoundation.h>
#endif

namespace nano_platform {

inline std::string generateUuid() {
#ifdef _WIN32
  UUID u{};
  if (UuidCreate(&u) != RPC_S_OK) return {};
  char buf[37];
  std::snprintf(buf, sizeof(buf),
                "%08lX-%04X-%04X-%02X%02X-%02X%02X%02X%02X%02X%02X",
                (unsigned long)u.Data1, u.Data2, u.Data3,
                u.Data4[0], u.Data4[1], u.Data4[2], u.Data4[3],
                u.Data4[4], u.Data4[5], u.Data4[6], u.Data4[7]);
  return std::string(buf);
#else
  // CFUUID, not NSUUID: the same bytes and the same formatting, from a plain C
  // API, so this header works in a .cpp.
  CFUUIDRef uuid = CFUUIDCreate(kCFAllocatorDefault);
  if (!uuid) return {};
  CFStringRef str = CFUUIDCreateString(kCFAllocatorDefault, uuid);
  CFRelease(uuid);
  if (!str) return {};
  char buf[64] = {0};
  const bool ok = CFStringGetCString(str, buf, sizeof(buf), kCFStringEncodingUTF8);
  CFRelease(str);
  return ok ? std::string(buf) : std::string();
#endif
}

}  // namespace nano_platform
