/**
 * Vite plugin: naga bridge.
 *
 * Exposes `POST /__naga/wgsl` so the browser can hand SPIR-V bytes
 * to naga (running locally as a subprocess) and get WGSL back. This
 * is the runtime side of the "build emits SPV, runtime translates"
 * shader pipeline — see EFFECTS_STYLE_GUIDE.md and the proposal in
 * the Phase-3 fusion notes for the architectural rationale.
 *
 * Why this lives in the dev server:
 *   - WebGPU doesn't accept SPIR-V; we must produce WGSL.
 *   - naga is a Rust CLI; running it as a subprocess on the dev host
 *     keeps the browser bundle small (no naga.wasm required) and
 *     lets us pick up naga upgrades without rebuilding the app.
 *   - The endpoint is dev-only — production builds will pre-bake
 *     WGSL via the same mechanism at compile time.
 *
 * Caching: the plugin keys responses on the SHA-256 of the request
 * body, so identical SPV blobs (same effect, same compile flags)
 * skip the spawn after the first hit. The cache lives in-memory and
 * dies with the dev server.
 *
 * Body: raw SPV bytes (Content-Type: application/octet-stream).
 * Optional query params (must match the corresponding HLSL register
 * declarations the build emitted, which naga can't infer from
 * SPIR-V):
 *   - storageFormat=rgba8unorm (default) | rgba16float | r32float | ...
 *   - storageAccess=write (default) | read_write
 * The plugin runs `sed` on naga's output to substitute these for
 * `rgba32float,read_write` (naga's default for HLSL `RWTexture2D<float4>`).
 */

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Plugin } from 'vite';

interface CacheEntry {
  wgsl: string;
}

export function nagaBridgePlugin(): Plugin {
  const cache = new Map<string, CacheEntry>();

  return {
    name: 'nano-modules:naga-bridge',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__naga/wgsl', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('POST only');
          return;
        }

        // Collect the request body (raw SPV bytes).
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const spv = Buffer.concat(chunks);
        if (spv.length === 0) {
          res.statusCode = 400;
          res.end('empty body');
          return;
        }

        // Parse query params with sensible defaults that match what the
        // build helper already does for storage textures.
        const url = new URL(req.url ?? '/', 'http://localhost');
        const storageFormat = url.searchParams.get('storageFormat') ?? 'rgba8unorm';
        const storageAccess = url.searchParams.get('storageAccess') ?? 'write';

        // Cache key: SPV hash + format params (substitution outputs differ).
        const hash = createHash('sha256');
        hash.update(spv);
        hash.update(`|${storageFormat}|${storageAccess}`);
        const key = hash.digest('hex');

        const hit = cache.get(key);
        if (hit) {
          res.setHeader('Content-Type', 'text/x-wgsl; charset=utf-8');
          res.setHeader('X-Naga-Cache', 'hit');
          res.end(hit.wgsl);
          return;
        }

        let tmpDir: string | null = null;
        try {
          tmpDir = mkdtempSync(join(tmpdir(), 'naga-bridge-'));
          const inPath = join(tmpDir, 'in.spv');
          const outPath = join(tmpDir, 'out.wgsl');
          writeFileSync(inPath, spv);

          await new Promise<void>((resolve, reject) => {
            const child = spawn('naga', [inPath, outPath], { stdio: ['ignore', 'pipe', 'pipe'] });
            let stderr = '';
            child.stderr.on('data', (d) => { stderr += d.toString(); });
            child.on('error', reject);
            child.on('close', (code) => {
              if (code === 0) resolve();
              else reject(new Error(`naga exited with code ${code}: ${stderr}`));
            });
          });

          let wgsl = readFileSync(outPath, 'utf8');
          // naga emits `rgba32float,read_write` as a default for HLSL
          // `RWTexture2D<float4>`; the build helpers fixed this up via
          // sed. Mirror it here so the output matches what the engine
          // expects at the bind-group layout level.
          wgsl = wgsl
            .replace(/rgba32float,read_write/g, `${storageFormat},${storageAccess}`)
            .replace(/rgba32float/g, storageFormat);

          cache.set(key, { wgsl });
          res.setHeader('Content-Type', 'text/x-wgsl; charset=utf-8');
          res.setHeader('X-Naga-Cache', 'miss');
          res.end(wgsl);
        } catch (err) {
          server.config.logger.error(`[naga-bridge] ${(err as Error).message}`);
          res.statusCode = 500;
          res.end(String(err));
        } finally {
          if (tmpDir) {
            try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
          }
        }
      });
    },
  };
}
