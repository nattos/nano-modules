#ifndef _SETJMP_H
#define _SETJMP_H
/* WASM shim: wasi-libc's <setjmp.h> hard-errors without the (non-standard)
 * exception-handling feature. The text engine's FreeType subset includes the
 * header (via ftstdlib.h) but NEVER calls setjmp/longjmp — only the smooth
 * rasterizer does, and we don't compile it. So we provide the types/decls to
 * satisfy the include; the symbols are never referenced. */
typedef long jmp_buf[8];
#ifdef __cplusplus
extern "C" {
#endif
int setjmp(jmp_buf);
void longjmp(jmp_buf, int);
#ifdef __cplusplus
}
#endif
#endif
