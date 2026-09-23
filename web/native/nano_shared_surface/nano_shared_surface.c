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
 *   release(buffer)
 *       Drops that reference. Call once Electron reports allReferencesReleased.
 *
 * Plain Node-API C: ABI-stable, so one build loads in any Electron version.
 * Windows (a named D3D11 NT handle) is not implemented yet — lookup returns
 * undefined there, and the app keeps the socket transport.
 */

#include <node_api.h>
#include <string.h>

#ifdef __APPLE__
#include <IOSurface/IOSurface.h>
#endif

static napi_value undefined_(napi_env env) {
  napi_value u;
  napi_get_undefined(env, &u);
  return u;
}

static napi_value lookup(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1)
    return undefined_(env);
  double token = 0;
  if (napi_get_value_double(env, argv[0], &token) != napi_ok || token <= 0)
    return undefined_(env);
#ifdef __APPLE__
  IOSurfaceRef surface = IOSurfaceLookup((IOSurfaceID)token);  /* +1 */
  if (!surface) return undefined_(env);
  void* data;
  napi_value buf;
  if (napi_create_buffer_copy(env, sizeof(surface), &surface, &data, &buf) != napi_ok) {
    CFRelease(surface);
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
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1)
    return undefined_(env);
  void* data = NULL;
  size_t len = 0;
  if (napi_get_buffer_info(env, argv[0], &data, &len) != napi_ok) return undefined_(env);
#ifdef __APPLE__
  if (len == sizeof(IOSurfaceRef)) {
    IOSurfaceRef surface;
    memcpy(&surface, data, sizeof(surface));
    if (surface) CFRelease(surface);
    memset(data, 0, len);  /* a second release is a no-op, not a double free */
  }
#endif
  return undefined_(env);
}

static napi_value init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "lookup", NAPI_AUTO_LENGTH, lookup, NULL, &fn);
  napi_set_named_property(env, exports, "lookup", fn);
  napi_create_function(env, "release", NAPI_AUTO_LENGTH, release_, NULL, &fn);
  napi_set_named_property(env, exports, "release", fn);
  return exports;
}

NAPI_MODULE(nano_shared_surface, init)
