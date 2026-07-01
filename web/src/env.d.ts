// Ambient declarations for build-tool globals the vite/esbuild pipeline provides
// at runtime but a bare `tsc --noEmit` doesn't know about. Keeping them here lets
// the type-check stay clean without pulling in lib combinations that conflict
// (e.g. the WebWorker lib clashes with the DOM lib this project also targets).

// Vite: `import.meta.hot`, `*?raw` / `*?url` imports, etc.
/// <reference types="vite/client" />

// The engine / compiler / wire workers run in a DedicatedWorkerGlobalScope. We
// only touch postMessage + onmessage; declaring the full WebWorker lib would
// collide with the DOM lib, so declare just the shape we use.
interface DedicatedWorkerGlobalScope {
  postMessage(message: any, transfer?: Transferable[]): void;
  onmessage: ((this: DedicatedWorkerGlobalScope, ev: MessageEvent) => any) | null;
}

// mobx's shipped .d.ts references the ES2024 `ReadonlySetLike` type; our lib
// target is ES2022, so declare the minimal shape mobx needs.
interface ReadonlySetLike<T> {
  has(value: T): boolean;
  keys(): IterableIterator<T>;
  readonly size: number;
}
