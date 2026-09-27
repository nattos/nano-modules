#!/usr/bin/env node
/**
 * bake-thumbs — render the Effects store's thumbnails to disk, headless.
 *
 * Runs the app's own bake (public/thumb-runner.html → PreviewEngine) against a
 * running dev server, so each image is exactly what the store caches. Writes
 * per effect `<id>.webp|png` (the thumbnail), `<id>.input.png` (image effects:
 * the same scene with the effect bypassed), plus `report.json` and an
 * `index.html` contact sheet flagging suspect scenes (blank / ≈ input / flat).
 *
 *   npm run thumbs -- [--only 'color.*,mod.shaper.remap'] [--no-debug]
 *                     [--out /tmp/effect-thumbs] [--base-url http://localhost:5173]
 *                     [--scenario <id>=<file.json>]... [--scenarios <map.json>]
 *                     [--strip 0.5,1,1.5,2,3]
 *
 * --scenario runs a scenario JSON (the format in
 * native/wasm_modules/include/preview_scenario.h) instead of the effect's
 * own — iterate on a scene here, then port it to the effect's preview() hook.
 * --scenarios does the same for many at once: a JSON object {id: scenario}
 * (and --only defaults to exactly those ids).
 * --strip also bakes each scene at those capture times, side by side, to
 * `<id>.strip.png` — for choosing a scenario's capture time.
 * The dev server's port comes from devindex (http://localhost:4999) when
 * --base-url / GPU_TEST_BASE_URL aren't given.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const opts = { only: [], out: '/tmp/effect-thumbs', baseUrl: process.env.GPU_TEST_BASE_URL ?? null, noDebug: false, scenarios: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--only') opts.only.push(...next().split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--out') opts.out = path.resolve(next());
    else if (a === '--base-url') opts.baseUrl = next();
    else if (a === '--no-debug') opts.noDebug = true;
    else if (a === '--strip') opts.strip = next().split(',').map(Number).filter((n) => Number.isFinite(n) && n >= 0);
    else if (a === '--scenario') {
      const v = next();
      const eq = v.indexOf('=');
      if (eq < 0) throw new Error('--scenario wants <id>=<file.json>');
      const text = fs.readFileSync(v.slice(eq + 1), 'utf8');
      JSON.parse(text); // fail early on a typo
      opts.scenarios[v.slice(0, eq)] = text;
    } else if (a === '--scenarios') {
      const map = JSON.parse(fs.readFileSync(next(), 'utf8'));
      for (const [id, sc] of Object.entries(map)) opts.scenarios[id] = JSON.stringify(sc);
      opts.mapOnly = true;
    } else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

async function resolveBaseUrl() {
  const res = await fetch('http://localhost:4999/api/servers').catch(() => null);
  if (!res?.ok) throw new Error('no --base-url and devindex (:4999) is not up');
  const { servers } = await res.json();
  const s = servers.find((x) => path.resolve(x.cwd) === webDir);
  if (!s) throw new Error(`devindex lists no dev server for ${webDir}`);
  return `http://localhost:${s.port}`;
}

function globRe(glob) {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

const isDebug = (id) => id.startsWith('debug.') || id.startsWith('testonly.');
const domainOf = (id) => id.split('.')[0];
const fileSafe = (id) => id.replace(/[^A-Za-z0-9._-]/g, '_');
const extOf = (mime) => (mime === 'image/webp' ? 'webp' : 'png');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function contactSheet(rows) {
  const groups = new Map();
  for (const r of rows) {
    const d = domainOf(r.id);
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(r);
  }
  const flagged = rows.filter((r) => r.flags.length).length;
  const unscened = rows.filter((r) => !r.hasScenario).length;
  const card = (r) => `
    <div class="card${r.flags.length ? ' bad' : ''}">
      <div class="imgs">
        ${r.file ? `<img src="${esc(r.file)}" title="thumbnail">` : `<div class="none">${r.kind === 'icon' ? 'icon tile' : 'no thumbnail'}</div>`}
        ${r.inputFile ? `<img class="input" src="${esc(r.inputFile)}" title="input (effect bypassed)">` : ''}
      </div>
      ${r.stripFile ? `<img class="strip" src="${esc(r.stripFile)}" title="capture times">` : ''}
      <div class="id">${esc(r.id)}</div>
      <div class="meta">${esc(r.kind)} · ${esc(r.bundle)}${r.diffFromInput != null ? ` · Δ ${r.diffFromInput.toFixed(1)}` : ''}${r.ms ? ` · ${r.ms} ms` : ''}</div>
      <div class="badges">
        ${r.hasScenario ? (r.override ? '<b class="ovr">override</b>' : '') : '<b class="nos">no scenario</b>'}
        ${r.flags.map((f) => `<b class="flag">${esc(f)}</b>`).join('')}
        ${r.error ? `<b class="flag">${esc(r.error)}</b>` : ''}
      </div>
      ${r.scenario ? `<details><summary>scenario</summary><pre>${esc(JSON.stringify(JSON.parse(r.scenario), null, 1))}</pre></details>` : ''}
    </div>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Effect thumbnails</title><style>
  body { background:#111317; color:#ddd; font:13px system-ui, sans-serif; margin:16px; }
  h2 { margin:24px 0 8px; font-size:15px; color:#aab; text-transform:capitalize; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(340px, 1fr)); gap:10px; }
  .card { background:#1b1d22; border:1px solid #2a2d34; border-radius:6px; padding:8px; }
  .card.bad { border-color:#a44; }
  .imgs { display:flex; gap:6px; align-items:flex-start; }
  .imgs img { width:240px; aspect-ratio:16/9; border-radius:4px; background:#000; }
  .imgs img.input { width:80px; opacity:.8; }
  .strip { display:block; width:100%; margin-top:6px; }
  .none { width:240px; aspect-ratio:16/9; display:grid; place-items:center; color:#666; border:1px dashed #333; }
  .id { margin-top:6px; font-weight:600; }
  .meta { color:#889; font-size:12px; }
  .badges b { display:inline-block; margin:4px 4px 0 0; padding:1px 6px; border-radius:8px; font-weight:500; font-size:11px; }
  .flag { background:#5a2323; color:#fbb; } .nos { background:#333; color:#aaa; } .ovr { background:#234a5a; color:#bdf; }
  pre { white-space:pre-wrap; font-size:11px; color:#9ab; }
  </style></head><body>
  <h1 style="font-size:18px">Effect thumbnails — ${rows.length} effects, ${flagged} flagged, ${unscened} without a scenario</h1>
  ${[...groups.entries()].map(([d, rs]) => `<h2>${esc(d)}</h2><div class="grid">${rs.map(card).join('')}</div>`).join('')}
  </body></html>`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const baseUrl = opts.baseUrl ?? await resolveBaseUrl();
  fs.mkdirSync(opts.out, { recursive: true });

  const args = ['--no-sandbox', '--disable-setuid-sandbox', '--enable-unsafe-webgpu'];
  if (process.platform !== 'win32') args.push('--enable-features=Vulkan');
  const browser = await puppeteer.launch({ headless: 'new', args });
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.error('[page]', e.message));
    await page.goto(`${baseUrl}/thumb-runner.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__thumbs, { timeout: 30_000 });
    const count = await page.evaluate(() => window.__thumbs.start());
    let catalog = await page.evaluate(() => window.__thumbs.catalog());
    console.log(`${count} effects loaded from ${baseUrl}`);

    if (opts.noDebug) catalog = catalog.filter((e) => !isDebug(e.id));
    if (opts.mapOnly && !opts.only.length) opts.only = Object.keys(opts.scenarios);
    if (opts.only.length) {
      const res = opts.only.map(globRe);
      catalog = catalog.filter((e) => res.some((re) => re.test(e.id)));
    }
    for (const id of Object.keys(opts.scenarios)) {
      if (!catalog.some((e) => e.id === id)) console.warn(`--scenario ${id}: not in the selection`);
    }
    catalog.sort((a, b) => a.id.localeCompare(b.id));

    const rows = [];
    for (const e of catalog) {
      const override = opts.scenarios[e.id];
      const t0 = Date.now();
      const row = {
        id: e.id, name: e.name, bundle: e.bundle, kind: e.kind,
        hasScenario: !!(override ?? e.scenario), override: !!override, scenario: override ?? e.scenario,
        flags: [], diffFromInput: null, file: null, inputFile: null,
      };
      try {
        const r = await page.evaluate((id, scenario) => window.__thumbs.audit(id, { scenario }), e.id, override ?? undefined);
        row.kind = r.kind;
        row.flags = r.flags;
        row.diffFromInput = r.diffFromInput;
        row.stats = r.thumb?.image?.stats ?? r.thumb?.graph?.stats ?? null;
        if (r.thumb) {
          row.file = `${fileSafe(e.id)}.${extOf(r.thumb.mime)}`;
          fs.writeFileSync(path.join(opts.out, row.file), Buffer.from(r.thumb.dataBase64, 'base64'));
        }
        if (r.input) {
          row.inputFile = `${fileSafe(e.id)}.input.${extOf(r.input.mime)}`;
          fs.writeFileSync(path.join(opts.out, row.inputFile), Buffer.from(r.input.dataBase64, 'base64'));
        }
        if (opts.strip?.length && r.kind !== 'icon') {
          const st = await page.evaluate((id, scenario, times) => window.__thumbs.strip(id, { scenario, times }), e.id, override ?? undefined, opts.strip);
          row.stripFile = `${fileSafe(e.id)}.strip.png`;
          fs.writeFileSync(path.join(opts.out, row.stripFile), Buffer.from(st.dataBase64, 'base64'));
        }
      } catch (err) {
        row.error = String(err?.message ?? err).split('\n')[0];
      }
      row.ms = Date.now() - t0;
      rows.push(row);
      const note = [...row.flags, ...(row.hasScenario ? [] : ['no scenario']), ...(row.error ? [row.error] : [])];
      console.log(`${row.flags.length || row.error ? '✗' : '✓'} ${e.id}${note.length ? `  (${note.join(', ')})` : ''}`);
    }

    fs.writeFileSync(path.join(opts.out, 'report.json'), JSON.stringify(rows, null, 1));
    fs.writeFileSync(path.join(opts.out, 'index.html'), contactSheet(rows));
    const bad = rows.filter((r) => r.flags.length || r.error).length;
    console.log(`\n${rows.length} baked, ${bad} flagged → ${path.join(opts.out, 'index.html')}`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
