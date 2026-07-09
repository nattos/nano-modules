/**
 * Code-registered device template registry.
 *
 * Templates are the "factory originals" in the fork lineage: each driver
 * module (drivers/*.ts) self-registers on import. Only main-thread code may
 * import driver modules (they touch MIDI I/O); workers never see this module.
 * The import that triggers registration lives in state/midi-controller.ts.
 */

import type { DeviceTemplate, PhysicalIdentity } from './midi-types';

const templates = new Map<string, DeviceTemplate>();

export function registerDeviceTemplate(template: DeviceTemplate<any>): void {
  if (templates.has(template.templateId)) {
    console.warn(`[device-registry] duplicate template id ${template.templateId}`);
  }
  templates.set(template.templateId, template as DeviceTemplate);
}

export function getDeviceTemplate(templateId: string): DeviceTemplate | undefined {
  return templates.get(templateId);
}

export function allDeviceTemplates(): DeviceTemplate[] {
  return [...templates.values()];
}

/** Templates whose portMatchers recognize an unknown port, best-guess first.
 *  Used to rank suggestions in define mode; empty when nothing matches. */
export function matchTemplatesForPort(identity: PhysicalIdentity): DeviceTemplate[] {
  const probe = `${identity.manufacturer} ${identity.name}`;
  return allDeviceTemplates().filter(t =>
    t.portMatchers.some(re => re.test(probe) || re.test(identity.name)));
}
