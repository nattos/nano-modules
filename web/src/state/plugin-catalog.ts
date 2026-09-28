/**
 * A native runtime's effect catalog → the editor's PluginInfo list.
 *
 * The shared runtime (a NanoBarrel in Resolume, or the arrangement's
 * nano_compositor) publishes `plugin_schemas`: `{ module_type: {key, id,
 * version, schema, ...picker metadata} }` (BarrelRuntime::schemasJson). A
 * remote editor loads no wasm, so this is its only source for each effect's
 * params and ports — derived here from the raw schema fields, the same way the
 * worker derives them locally.
 */

import type { PluginInfo } from '../engine-types';

/** One catalog entry as the runtime publishes it. */
export interface CatalogEntry {
  id: string; key?: string; version?: string; schema?: Record<string, any>;
  /** The effect's own picker metadata, forwarded verbatim by the runtime
   *  (name / description / category / keywords / icon / thumbnail). */
  name?: string; description?: string; category?: string; keywords?: string;
  icon?: string; thumbnail?: string;
}

/** The catalog's entries (a `plugin_schemas` object), skipping anything malformed. */
export function catalogEntries(schemasObj: unknown): CatalogEntry[] {
  if (!schemasObj || typeof schemasObj !== 'object') return [];
  return Object.values(schemasObj as Record<string, unknown>)
    .filter((v): v is CatalogEntry => !!v && typeof v === 'object' && typeof (v as any).id === 'string');
}

export function pluginInfosFromCatalog(remotePlugins: readonly CatalogEntry[]): PluginInfo[] {
  return remotePlugins.map(rp => {
    const schema = rp.schema ?? {};
    const params: PluginInfo['params'] = [];
    const io: PluginInfo['io'] = [];
    let paramIdx = 0;
    for (const [name, fieldRaw] of Object.entries(schema)) {
      const field = fieldRaw as any;
      const ioFlags = field?.io ?? 0;
      if (field?.type === 'texture') {
        const dir = (ioFlags & 1) ? 0 : 1;       // 0=input, 1=output
        const role = (ioFlags & 4) ? 0 : 1;       // 0=primary, 1=secondary
        io.push({ index: io.length, name, kind: dir, role });
      } else if (field?.type === 'object' || field?.type === 'array'
              || field?.type === 'float2' || field?.type === 'float3'
              || field?.type === 'float4'
              // A polymorphic port is a connection, never a barrel param —
              // classify it with the other structured io rather than letting
              // it fall through and become a Standard float knob.
              || field?.type === 'any') {
        if (ioFlags & 2) {
          const role = (ioFlags & 4) ? 0 : 1;
          io.push({ index: io.length, name, kind: 2, role });
        }
      } else {
        let type = 10;                            // Standard
        if (field?.type === 'bool') type = 0;
        else if (field?.type === 'event') type = 1;
        else if (field?.type === 'int') type = 13;
        else if (field?.type === 'string') type = 100;
        let defaultValue = 0;
        const fd = field?.default;
        if (typeof fd === 'number') defaultValue = fd;
        else if (typeof fd === 'boolean') defaultValue = fd ? 1 : 0;
        params.push({
          index: paramIdx++, name, type, defaultValue,
          min: typeof field?.min === 'number' ? field.min : 0,
          max: typeof field?.max === 'number' ? field.max : 1,
        });
        if (ioFlags & 2) {
          const role = (ioFlags & 4) ? 0 : 1;
          io.push({ index: io.length, name, kind: 2, role });
        }
      }
    }
    return {
      key: rp.key ?? rp.id,
      id: rp.id,
      version: rp.version ?? '0.0.0',
      moduleVersion: (rp as any).moduleVersion ?? '0.0.0',
      params, io, schema,
      // Forwarded by the barrel host when present; harmless [] otherwise.
      capabilities: Array.isArray((rp as any).capabilities) ? (rp as any).capabilities : [],
    };
  });
}
