/*
 * nano_shared_surface — open a GPU surface another process shared, for
 * Electron's sharedTexture module.
 *
 * The FFGL plugin renders previews into cross-process surfaces
 * (GPUBackend::createSharedSurface) and announces each by a numeric token.
 * Electron's `sharedTexture.importSharedTexture` wants a handle that is LOCAL
 * to the importing process, so the main process opens the token here:
 *
 *   lookup(token) -> Buffer | undefined
 *       macOS: IOSurfaceLookup(token) — the surface is global, exactly as
 *       Syphon's are. The Buffer holds the IOSurfaceRef (what
 *       `handle.ioSurface` expects) and owns one reference to it.
 *       Windows: the D3D11 texture shared under the name the token encodes,
 *       opened as an NT handle local to this process (what `handle.ntHandle`
 *       expects) — native/src/gpu/shared_surface_win.h, which the producer
 *       includes too. The Buffer holds the HANDLE.
 *   release(buffer)
 *       Drops that reference (CFRelease / CloseHandle). Call once Electron
 *       reports allReferencesReleased.
 *
 * Plain Node-API C: ABI-stable, so one build loads in any Electron version.
 * On Windows it links against nothing from Node: an addon normally imports
 * the napi_* functions from "node.exe" through node.lib plus a delay-load hook
 * that redirects them to whatever the host executable is called. Here each
 * call resolves the function from the host executable itself (Electron
 * exports them), so the cross-build from macOS needs no node.lib.
 */

#include <node_api.h>
#include <string.h>

#ifdef __APPLE__
#include <IOSurface/IOSurface.h>
#endif

#ifdef _WIN32
#include "gpu/shared_surface_win.h"
static FARPROC napi_sym_(const char* name) {
  return GetProcAddress(GetModuleHandleW(NULL), name);
}
/* N(napi_foo)(args...) calls the host's napi_foo. */
#define N(fn) ((__typeof__(&fn))(void*)napi_sym_(#fn))
#else
#define N(fn) fn
#endif

static napi_value undefined_(napi_env env) {
  napi_value u;
  N(napi_get_undefined)(env, &u);
  return u;
}

static napi_value lookup(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (N(napi_get_cb_info)(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1)
    return undefined_(env);
  double token = 0;
  if (N(napi_get_value_double)(env, argv[0], &token) != napi_ok || token <= 0)
    return undefined_(env);
#ifdef __APPLE__
  IOSurfaceRef surface = IOSurfaceLookup((IOSurfaceID)token);  /* +1 */
  if (!surface) return undefined_(env);
  void* data;
  napi_value buf;
  if (N(napi_create_buffer_copy)(env, sizeof(surface), &surface, &data, &buf) != napi_ok) {
    CFRelease(surface);
    return undefined_(env);
  }
  return buf;
#elif defined(_WIN32)
  HANDLE handle = nano_surface_open((uint64_t)token);
  if (!handle) return undefined_(env);
  void* data;
  napi_value buf;
  if (N(napi_create_buffer_copy)(env, sizeof(handle), &handle, &data, &buf) != napi_ok) {
    CloseHandle(handle);
    return undefined_(env);
  }
  return buf;
#else
  return undefined_(env);
#endif
}

static napi_value release_(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (N(napi_get_cb_info)(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1)
    return undefined_(env);
  void* data = NULL;
  size_t len = 0;
  if (N(napi_get_buffer_info)(env, argv[0], &data, &len) != napi_ok) return undefined_(env);
#ifdef __APPLE__
  if (len == sizeof(IOSurfaceRef)) {
    IOSurfaceRef surface;
    memcpy(&surface, data, sizeof(surface));
    if (surface) CFRelease(surface);
    memset(data, 0, len);  /* a second release is a no-op, not a double free */
  }
#elif defined(_WIN32)
  if (len == sizeof(HANDLE)) {
    HANDLE handle;
    memcpy(&handle, data, sizeof(handle));
    if (handle) CloseHandle(handle);
    memset(data, 0, len);
  }
#endif
  return undefined_(env);
}

static napi_value init(napi_env env, napi_value exports) {
  napi_value fn;
  N(napi_create_function)(env, "lookup", NAPI_AUTO_LENGTH, lookup, NULL, &fn);
  N(napi_set_named_property)(env, exports, "lookup", fn);
  N(napi_create_function)(env, "release", NAPI_AUTO_LENGTH, release_, NULL, &fn);
  N(napi_set_named_property)(env, exports, "release", fn);
  return exports;
}

NAPI_MODULE(nano_shared_surface, init)
