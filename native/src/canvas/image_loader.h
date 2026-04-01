#pragma once

#ifdef __APPLE__
#include <OpenGL/gl3.h>
#else
#include <GL/glew.h>
#endif

// Fetch an image from a URL and upload it as a GL texture.
// Returns the texture handle, or 0 on failure.
// The texture is RGBA8, with LINEAR filtering.
// `out_w` and `out_h` receive the image dimensions.
// This is a synchronous/blocking call.
GLuint load_texture_from_url(const char* url, int* out_w = nullptr, int* out_h = nullptr);
