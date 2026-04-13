/**
 * Structural compatibility check for schema subtrees.
 *
 * Used to validate that a writer port's schema is assignable to a
 * reader port's schema when binding a struct rail. The check is
 * shape-by-shape: object fields must match by name (extra fields on
 * the writer are ignored); arrays must match `elementType` and their
 * `gpu` flag; leaf types must match exactly.
 */

export type SchemaNode = Record<string, any>;

export interface CompatOptions {
  /** If true, writer objects may have extra fields not on the reader. */
  allowExtraWriterFields?: boolean;
}

export function isRailCompatible(
  writer: SchemaNode | undefined,
  reader: SchemaNode | undefined,
  opts: CompatOptions = {},
): boolean {
  return nodeCompatible(writer, reader, opts) === null;
}

/** Returns null on compat; otherwise a short, human-readable reason. */
export function railCompatError(
  writer: SchemaNode | undefined,
  reader: SchemaNode | undefined,
  opts: CompatOptions = {},
): string | null {
  return nodeCompatible(writer, reader, opts);
}

function nodeCompatible(
  writer: SchemaNode | undefined,
  reader: SchemaNode | undefined,
  opts: CompatOptions,
  path: string = '',
): string | null {
  if (!writer || !reader) {
    return `${path || '<root>'}: missing schema on ${!writer ? 'writer' : 'reader'}`;
  }
  const wt = writer.type;
  const rt = reader.type;
  if (wt !== rt) {
    return `${path || '<root>'}: type mismatch ${wt} vs ${rt}`;
  }
  switch (wt) {
    case 'float':
    case 'int':
    case 'bool':
    case 'string':
    case 'event':
    case 'texture':
      return null;
    case 'array': {
      if (!!writer.gpu !== !!reader.gpu) {
        return `${path}: gpu flag mismatch`;
      }
      // If either side declares an elementType, require structural match.
      const we = writer.elementType;
      const re = reader.elementType;
      if (we || re) {
        return nodeCompatible(we, re, opts, `${path}[]`);
      }
      return null;
    }
    case 'object': {
      const wf: Record<string, any> = writer.fields ?? {};
      const rf: Record<string, any> = reader.fields ?? {};
      for (const [name, def] of Object.entries(rf)) {
        if (!(name in wf)) {
          return `${path}/${name}: missing on writer`;
        }
        const err = nodeCompatible(wf[name], def, opts, `${path}/${name}`);
        if (err) return err;
      }
      if (!opts.allowExtraWriterFields) {
        for (const name of Object.keys(wf)) {
          if (!(name in rf)) {
            return `${path}/${name}: extra field on writer`;
          }
        }
      }
      return null;
    }
    default:
      // Unknown type — pass through rather than reject, so new types
      // don't silently break existing connections during migration.
      return null;
  }
}
