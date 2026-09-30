/*
 * shared_surface_win.h — how a D3D11 shared preview surface is named, and how
 * ANOTHER process opens it. Plain C, header-only: the producer (d3d11_backend's
 * createSharedSurface), the Electron addon (web/native/nano_shared_surface) and
 * the test that reads a surface back all include this one file, so the two
 * sides cannot drift.
 *
 * A surface is a D3D11 texture shared as a NAMED NT handle:
 *
 *   Local\nano_surf_<pid>_<serial>
 *
 * and its share token (the u64 in an NBPS announcement) is pid·2^24 + serial.
 * It stays below 2^53, so it survives a trip through a JS number, and a serial
 * is never reused within a process — unlike a handle value, which Windows hands
 * out again as soon as one is closed, and which would let an editor keep
 * showing a surface it imported earlier under the same number.
 *
 * The consumer opens the name with D3DKMTOpenNtHandleFromName, which needs no
 * D3D device, and gets an NT handle LOCAL to itself — what Electron's
 * sharedTexture import takes (`handle.ntHandle`). That call takes the kernel's
 * object path, not the Win32 "Local\" form: the session's BaseNamedObjects.
 */
#ifndef NANO_SHARED_SURFACE_WIN_H
#define NANO_SHARED_SURFACE_WIN_H

#ifdef _WIN32
#include <windows.h>
#include <stdint.h>
#include <stdio.h>
#include <wchar.h>

#define NANO_SURFACE_SERIAL_BITS 24
#define NANO_SURFACE_SERIAL_MASK ((1u << NANO_SURFACE_SERIAL_BITS) - 1u)

/* 0 when `pid` doesn't fit (a token must stay below 2^53) or serial is 0. */
static inline uint64_t nano_surface_token(uint32_t pid, uint32_t serial) {
  serial &= NANO_SURFACE_SERIAL_MASK;
  if (serial == 0 || pid >= (1u << (53 - NANO_SURFACE_SERIAL_BITS))) return 0;
  return ((uint64_t)pid << NANO_SURFACE_SERIAL_BITS) | serial;
}

/* The name the producer shares under (IDXGIResource1::CreateSharedHandle). */
static inline void nano_surface_win32_name(uint64_t token, wchar_t* out, size_t cap) {
  swprintf(out, cap, L"Local\\nano_surf_%u_%u",
           (unsigned)(token >> NANO_SURFACE_SERIAL_BITS),
           (unsigned)(token & NANO_SURFACE_SERIAL_MASK));
}

/* DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE. */
#define NANO_SURFACE_ACCESS (0x80000000ul | 0x1ul)

/* The pieces of winternl.h / d3dkmthk.h this needs, spelled out so neither
 * header (nor an import library) is required. */
typedef struct {
  USHORT Length;
  USHORT MaximumLength;
  PWSTR Buffer;
} NanoUnicodeString;
typedef struct {
  ULONG Length;
  HANDLE RootDirectory;
  NanoUnicodeString* ObjectName;
  ULONG Attributes;
  PVOID SecurityDescriptor;
  PVOID SecurityQualityOfService;
} NanoObjectAttributes;
typedef struct {
  DWORD dwDesiredAccess;
  NanoObjectAttributes* pObjAttrib;
  HANDLE hNtHandle;
} NanoOpenNtHandleFromName;
typedef LONG(APIENTRY* NanoPfnOpenNtHandleFromName)(NanoOpenNtHandleFromName*);

/* Open the surface `token` names as an NT handle owned by the caller
 * (CloseHandle it), or NULL — no such surface, another session, or a system
 * without the call (it is Windows 8+). */
static inline HANDLE nano_surface_open(uint64_t token) {
  static NanoPfnOpenNtHandleFromName open_fn = NULL;
  static int resolved = 0;
  if (!resolved) {
    HMODULE gdi = LoadLibraryW(L"gdi32.dll");
    open_fn = gdi ? (NanoPfnOpenNtHandleFromName)(void*)GetProcAddress(
                        gdi, "D3DKMTOpenNtHandleFromName")
                  : NULL;
    resolved = 1;
  }
  if (!open_fn || token == 0) return NULL;

  /* "Local\" is this session's BaseNamedObjects; session 0 has no prefix. */
  DWORD session = 0;
  ProcessIdToSessionId(GetCurrentProcessId(), &session);
  wchar_t path[128];
  const unsigned pid = (unsigned)(token >> NANO_SURFACE_SERIAL_BITS);
  const unsigned serial = (unsigned)(token & NANO_SURFACE_SERIAL_MASK);
  if (session == 0) {
    swprintf(path, 128, L"\\BaseNamedObjects\\nano_surf_%u_%u", pid, serial);
  } else {
    swprintf(path, 128, L"\\Sessions\\%lu\\BaseNamedObjects\\nano_surf_%u_%u",
             (unsigned long)session, pid, serial);
  }
  NanoUnicodeString name;
  name.Length = (USHORT)(wcslen(path) * sizeof(wchar_t));
  name.MaximumLength = (USHORT)(name.Length + sizeof(wchar_t));
  name.Buffer = path;
  NanoObjectAttributes oa;
  ZeroMemory(&oa, sizeof oa);
  oa.Length = sizeof oa;
  oa.ObjectName = &name;
  oa.Attributes = 0x40; /* OBJ_CASE_INSENSITIVE */
  NanoOpenNtHandleFromName args;
  args.dwDesiredAccess = NANO_SURFACE_ACCESS;
  args.pObjAttrib = &oa;
  args.hNtHandle = NULL;
  if (open_fn(&args) < 0) return NULL;
  return args.hNtHandle;
}

#endif /* _WIN32 */
#endif /* NANO_SHARED_SURFACE_WIN_H */
