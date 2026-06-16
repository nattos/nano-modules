/* Minimal x86_64 libzstd stub so the prebuilt (Intel) wamrc can load on Apple
 * Silicon under Rosetta. wamrc pulls these in via LLVM's optional compression
 * support; AOT emission does not actually compress, so they are never called.
 * If they ever are, ZSTD_compress reports an error and LLVM falls back to
 * uncompressed output. */
#include <stddef.h>
size_t ZSTD_compress(void* d, size_t dc, const void* s, size_t ss, int l) {
  (void)d;(void)dc;(void)s;(void)ss;(void)l; return (size_t)-1; /* error code */
}
size_t ZSTD_compressBound(size_t ss) { return ss + (ss >> 8) + 512; }
size_t ZSTD_decompress(void* d, size_t dc, const void* s, size_t ss) {
  (void)d;(void)dc;(void)s;(void)ss; return (size_t)-1;
}
const char* ZSTD_getErrorName(size_t c) { (void)c; return "zstd stub (unsupported)"; }
unsigned ZSTD_isError(size_t c) { return c > (size_t)-128; } /* top range = errors */
