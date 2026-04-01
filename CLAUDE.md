# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Nano Repatch is a node-based visual programming environment for real-time audio/graphics synthesis, built as a web app. The core engine is called **Structor** — a statically analyzable execution graph system with universal broadcast semantics.

## Commands

```bash
npm run dev          # Start Vite dev server
npm run build        # Type-check (tsc) then bundle (vite build)
npm test             # Run Vitest unit tests (co-located in src/)
npm run test:e2e     # Run Jest+Puppeteer E2E tests (in test/, requires dev server on port 5173)
```

No separate lint command — TypeScript strict mode (`strict: true`, `noImplicitAny: true`) is the primary static check.

## Architecture

### Multi-threaded Design

The app runs across four threads communicating via `postMessage`:

- **Main thread**: UI (Lit web components + MobX reactivity), state management (`AppController`, `LocalController`)
- **CompilerWorker**: Compiles UI graph state into executable `GraphDefinition`
- **ExecutorWorker**: Runs `GraphExecutor` loop with dirty-tracking
- **Wire Layout Worker**: Calculates wire routing paths

### Worker Isolation Rules

Node definitions split logic from UI to avoid circular imports in worker bundles:
- `nodes.ts` — Pure logic, shared with workers. No DOM/Lit/window imports.
- `ui-registration.ts` — Registers UI editors/renderers to node definitions. Only imported from `controllers.ts` (main thread).

### Serialization Boundary

MobX proxies cannot cross `postMessage`. Always sanitize with `JSON.parse(JSON.stringify(toJS(data)))` before sending to workers.

### Core Data Model

- **Structor**: Runtime data unit (atomic value, array, record, or functor)
- **StructorType**: Static type counterpart for compile-time analysis
- **Broadcast**: Universal operation for declarative data reshaping — nodes write scalar logic, the broadcast engine handles vectorization
- **Grab Bag Inputs**: Each node receives a single `StructorRecord` with all connected inputs (named `fields` + ordered `untagged`)

### State Architecture

- **AppController**: Graph state (nodes, connections), undo/redo (immer + command pattern), serialization
- **LocalController**: UI state (selection, viewport, metrics)
- **RuntimeManager**: Orchestrates workers and execution
- **TUIConfig vs TCompiledConfig**: Inspector-editable state vs processed runtime state. Always use `<TUIConfig, TCompiledConfig>` generics in `defineNode`.

### "Hero Node" Side-Channel

High-frequency visualization data (FFT, envelopes) bypasses MobX via a `ui` output property. Editor components poll `runtimeManager.uiStates.get(nodeId)` via `requestAnimationFrame`.

## Node Development

Nodes are defined with `defineNode`/`definePrimitiveNode` from `src/structor/type-helpers.ts`:

- `execute` must return a record matching `outputs` (e.g., `{ result: 5 }`)
- With `autoBroadcast: true`, `execute` receives scalars — the system iterates over vectors automatically
- Config schemas use spread syntax (`{ ...numberType, defaultValue: 60 }`), NOT `{ type: numberType }`
- Define inputs with `defaultValue` for virtual inputs — don't duplicate in both `inputs` and `config`
- Register nodes in `ALL_PRIMITIVES` in `src/structor/primitives.ts`
- Stateful nodes: use `createState` + `initialized` flag to avoid ghost triggers on first frame

## Testing

- **Vitest** unit tests: co-located as `*.test.ts` in `src/`. Config in `vite.config.ts`.
- **Jest+Puppeteer** E2E tests: in `test/` directory. Do not mix Jest/Vitest syntax.
- E2E tests use `window.testing.appController` for programmatic state setup. Use `page.evaluate()` for shadow DOM traversal.
- Virtual inputs in tests: `executor.setNodeConfig(id, { values: { trigger: ... } })` — use the `values` sub-key.
- Environment mocks (Canvas, MIDI, AudioContext, Monaco) configured in `src/vitest.setup.ts`.

## Key Pitfalls

- `GraphExecutor.setNodeConfig` does shallow merge of top-level keys — never replace the entire config object with a partial update
- Moving a region must recursively move/push all children and their contents
- Collapsed region detection requires checking `MetricsProvider` (visibility can be `'auto'`)
- AudioContext state must be mirrored from main thread to worker via explicit messages — don't trust worker's view
- Nodes with dynamic ports need `shouldRecompileOnConfigChange` returning `true` to trigger topology updates
- Feedback loops use `cycleBreakingPorts` + two-phase execution (`execute` then `consolidate`)
