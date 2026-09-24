# Nano Modules settings

This folder holds the settings of the NanoModules desktop apps and the
NanoBarrel FFGL plugin. It is rewritten by the apps; edit the JSON files freely
(by hand, or with a script or coding agent) — **a running app or plugin picks
up an edit within about a second**, no restart needed, except where noted.

Rules for editing:

- Keep each file valid JSON. A file that doesn't parse is ignored and the
  current values stay; the next save from the app replaces it.
- Unknown keys are ignored (top-level ones survive the app's next save). A
  missing key leaves that setting alone — in `plugin.json`, it means the
  default.
- Write the whole file at once (or write `<name>.tmp` and rename it over), so
  nobody reads half an edit.

## One file per surface

### `arrangement.json` — the NanoModules app

```json
{
  "layout": {
    "activeRightTab": "inspector",
    "clipViewOpen": true, "clipViewHeight": 260,
    "sidePanelWidth": 320, "sideCollapsed": false,
    "headerWidth": 180, "monitorHeight": 240,
    "wiresMode": false, "automationMode": false, "helpMode": false,
    "lastFile": "show.nano-arr"
  },
  "workspace": { "path": "/Users/me/Shows/tour", "label": "tour" }
}
```

- `layout` applies live. `activeRightTab` is one of `inspector`, `workspace`,
  `settings`, `export`, `debug`. `lastFile` is the document re-opened at the
  next launch.
- `workspace` is the open project folder; pointing it at another folder opens
  that folder.

### `remote-control.json` — the Remote Control app (Live + Playground)

```json
{
  "settings": {
    "targetFps": 60, "paused": false,
    "barrelRemoteEnabled": true,
    "activeTab": "edit", "editLeftPanelWidth": 320, "sketchCanvasOpen": false,
    "instanceNames": {}, "sidechannelNames": {},
    "deviceFilters": { "connected": true, "disconnected": true, "unrecognized": true,
                       "templates": true, "deleted": false },
    "devicesMonitorHeight": 180,
    "appMode": "live"
  },
  "selectedInstance": { "barrel": "<instance key>", "playground": "<sketch id>" },
  "inputVideo": { "path": "/Users/me/Videos/test.mp4", "label": "test.mp4" }
}
```

- `settings` applies live, except `appMode` and `barrelRemoteEnabled`, which
  take effect at the next launch.
- `selectedInstance` and `inputVideo` are read at launch.

### `plugin.json` — the NanoBarrel FFGL plugin

```json
{
  "previewHz": 30,
  "previewMaxDim": 4096,
  "previewFanout": 8,
  "previewChunkKB": 256
}
```

- `previewHz` (editor preview frame rate) and `previewMaxDim` (preview long
  edge, px) apply live.
- `previewFanout` and `previewChunkKB` shape the preview transport and apply
  when the host (Resolume) next loads the plugin.
- The matching environment variables (`NANO_BARREL_PREVIEW_HZ`,
  `NANO_BARREL_PREVIEW_MAXDIM`, `NANO_PREVIEW_FANOUT`, `NANO_PREVIEW_CHUNK_KB`)
  override the file.

## Shared files

### `midi-devices.json` — the MIDI device library

An array of device instances, shared by Remote Control and the plugin (a
browser editor reaches it through the plugin). Both apply edits live. An empty
array never replaces a non-empty library — remove devices from the app's
Devices tab (they are soft-deleted, so wires keep their provenance).

### `library-paths.json` — media library roots

`[{ "id", "label", "absolutePath", "addedAt" }]`. The arrangement app adopts a
browser-made document's library here ("Locate…"), and the plugin resolves
library-relative media against it. A browser editor's roots are merged in by
`id`, never replacing the desktop's.

### `module-paths.json` — extra effect-module folders

`{ "paths": [{ "path": "/Users/me/MyEffects", "enabled": true }] }`, edited in
the app's Settings. Read at launch — by the apps, and by the plugin when the
host loads it.

## Elsewhere

- `../Modules/` — the effect bundles every app and the plugin load.
- `../install.json` — where the packaged app lives (for the plugin to find its
  resources). Written by the app; not a setting.
- `NANO_DATA_DIR` moves this whole folder tree (the parent of `Settings/`).
