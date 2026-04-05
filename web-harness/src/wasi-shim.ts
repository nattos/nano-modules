/**
 * Minimal WASI shim for running wasm32-wasip1 modules in the browser.
 * Only provides the 6 imports that C++/libc++ modules need.
 */

export function createWasiShim(getMemory: () => WebAssembly.Memory): WebAssembly.ModuleImports {
  return {
    args_get: (_argv: number, _argvBuf: number): number => {
      return 0; // __WASI_ERRNO_SUCCESS, no args
    },
    args_sizes_get: (countPtr: number, sizePtr: number): number => {
      const view = new DataView(getMemory().buffer);
      view.setUint32(countPtr, 0, true); // 0 args
      view.setUint32(sizePtr, 0, true);  // 0 bytes
      return 0;
    },
    fd_close: (_fd: number): number => {
      return 0;
    },
    fd_seek: (_fd: number, _offset: bigint, _whence: number, _newOffset: number): number => {
      return 0;
    },
    fd_write: (_fd: number, _iovs: number, _iovsLen: number, _nwritten: number): number => {
      return 0;
    },
    proc_exit: (_code: number): void => {
      // No-op in browser context
    },
    // Additional stubs that some builds may need
    environ_get: (_environ: number, _environBuf: number): number => {
      return 0;
    },
    environ_sizes_get: (countPtr: number, sizePtr: number): number => {
      const view = new DataView(getMemory().buffer);
      view.setUint32(countPtr, 0, true);
      view.setUint32(sizePtr, 0, true);
      return 0;
    },
    clock_time_get: (_id: number, _precision: bigint, _timePtr: number): number => {
      const view = new DataView(getMemory().buffer);
      view.setBigUint64(_timePtr, BigInt(Date.now()) * 1000000n, true);
      return 0;
    },
  };
}
