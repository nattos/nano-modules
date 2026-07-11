import { describe, expect, it } from 'vitest';
import { observable, toJS } from 'mobx';
import { MFT_TEMPLATE } from './drivers/mft';
import { forkInstance, matchInstanceForPort } from './matching';
import type { DeviceInstance, PhysicalIdentity } from './midi-types';

const TWISTER: PhysicalIdentity = { name: 'Midi Fighter Twister', manufacturer: 'DJ TechTools' };

function fork(identities: PhysicalIdentity[] = [], deleted = false): DeviceInstance {
  const inst = forkInstance(MFT_TEMPLATE);
  inst.identities = identities;
  if (deleted) inst.deleted = true;
  return inst;
}

describe('matchInstanceForPort', () => {
  it('prefers an exact webPortId hit over an earlier tuple hit', () => {
    const tupleOnly = fork([{ ...TWISTER }]);
    const exact = fork([{ ...TWISTER, webPortId: 'port-9' }]);
    const match = matchInstanceForPort([tupleOnly, exact], { ...TWISTER, webPortId: 'port-9' });
    expect(match?.instance.id).toBe(exact.id);
    expect(match?.exact).toBe(true);
  });

  it('falls back to the first tuple match in library order', () => {
    const a = fork([{ ...TWISTER }]);
    const b = fork([{ ...TWISTER }]);
    const match = matchInstanceForPort([a, b], { ...TWISTER, webPortId: 'new-port' });
    expect(match?.instance.id).toBe(a.id);
    expect(match?.exact).toBe(false);
  });

  it('skips deleted instances and instances already taken this pass', () => {
    const dead = fork([{ ...TWISTER }], true);
    const a = fork([{ ...TWISTER }]);
    const b = fork([{ ...TWISTER }]);
    expect(matchInstanceForPort([dead, a, b], TWISTER)?.instance.id).toBe(a.id);
    expect(matchInstanceForPort([dead, a, b], TWISTER, new Set([a.id]))?.instance.id).toBe(b.id);
  });

  it('returns null when nothing claims the port', () => {
    expect(matchInstanceForPort([fork()], TWISTER)).toBeNull();
  });
});

describe('forkInstance', () => {
  it('forks a template: lineage to templateId, independent config copy', () => {
    const inst = forkInstance(MFT_TEMPLATE);
    expect(inst.templateId).toBe(MFT_TEMPLATE.templateId);
    expect(inst.parentId).toBe(MFT_TEMPLATE.templateId);
    expect(inst.identities).toEqual([]);
    expect(inst.config).toEqual(MFT_TEMPLATE.defaultConfig);
    (inst.config as typeof MFT_TEMPLATE.defaultConfig).encoders[0].cc = 99;
    expect(MFT_TEMPLATE.defaultConfig.encoders[0].cc).toBe(0);   // template untouched
  });

  it('forks an instance: lineage to the instance id, config copied not shared', () => {
    const parent = forkInstance(MFT_TEMPLATE);
    (parent.config as typeof MFT_TEMPLATE.defaultConfig).encoders[3].cc = 77;
    const child = forkInstance(parent);
    expect(child.parentId).toBe(parent.id);
    expect(child.templateId).toBe(MFT_TEMPLATE.templateId);
    expect((child.config as typeof MFT_TEMPLATE.defaultConfig).encoders[3].cc).toBe(77);
    (child.config as typeof MFT_TEMPLATE.defaultConfig).encoders[3].cc = 11;
    expect((parent.config as typeof MFT_TEMPLATE.defaultConfig).encoders[3].cc).toBe(77);
  });

  it('forks a MobX-observable instance without DataCloneError', () => {
    // Regression: structuredClone throws DataCloneError on observable
    // proxies — any caller forking a live library instance hits that.
    const parent = observable(forkInstance(MFT_TEMPLATE));
    const child = forkInstance(parent);
    expect(child.parentId).toBe(parent.id);
    expect(child.config).toEqual(toJS(parent.config));
  });

  it('uniquifies display names against the library', () => {
    expect(forkInstance(MFT_TEMPLATE, []).name).toBe('Midi Fighter Twister');
    expect(forkInstance(MFT_TEMPLATE, ['Midi Fighter Twister']).name).toBe('Midi Fighter Twister 2');
    expect(forkInstance(MFT_TEMPLATE, ['Midi Fighter Twister', 'Midi Fighter Twister 2']).name)
      .toBe('Midi Fighter Twister 3');
  });
});
