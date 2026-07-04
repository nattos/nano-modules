import { describe, it, expect, beforeEach } from 'vitest';
import { runInAction } from 'mobx';
import { appState } from './app-state';
import { appController } from './controller';
import {
  sidechannelDefaultLabel, sidechannelDisplayLabel,
} from './sidechannel-labels';

describe('sidechannel labels', () => {
  beforeEach(() => {
    runInAction(() => {
      appState.local.barrelInstances = [
        { key: 'pg:aaaa', id: 'playground', label: 'Instance 1' },
      ];
      appState.local.engine.sidechannels = {
        '2': { writer: 'pg:aaaa', w: 1920, h: 1080 },
        'aux': { writer: 'FEEDFACE-1111', w: 640, h: 360 },
      };
      appState.local.userSettings.sidechannelNames = {};
    });
  });

  it('default label is "<channel> — <writer label>" once written', () => {
    expect(sidechannelDefaultLabel('2')).toBe('2 — Instance 1');
  });

  it('unknown writers fall back to the first UUID segment', () => {
    expect(sidechannelDefaultLabel('aux')).toBe('aux — FEEDFACE');
  });

  it('an unwritten channel is just its name', () => {
    expect(sidechannelDefaultLabel('7')).toBe('7');
  });

  it('no override shows the default', () => {
    expect(sidechannelDisplayLabel('2')).toBe('2 — Instance 1');
  });

  it('a plain override fully renames', () => {
    runInAction(() => { appState.local.userSettings.sidechannelNames['2'] = 'Drums'; });
    expect(sidechannelDisplayLabel('2')).toBe('Drums');
  });

  it('"#" in the override expands to the default label', () => {
    runInAction(() => { appState.local.userSettings.sidechannelNames['2'] = 'Drums #'; });
    expect(sidechannelDisplayLabel('2')).toBe('Drums 2 — Instance 1');
  });

  it('blank or "#" overrides behave as the pure default', () => {
    runInAction(() => { appState.local.userSettings.sidechannelNames['2'] = '   '; });
    expect(sidechannelDisplayLabel('2')).toBe('2 — Instance 1');
    runInAction(() => { appState.local.userSettings.sidechannelNames['2'] = '#'; });
    expect(sidechannelDisplayLabel('2')).toBe('2 — Instance 1');
  });

  it('setSidechannelDisplayName stores overrides and drops default-equivalents', () => {
    appController.setSidechannelDisplayName('2', 'Drums #');
    expect(appState.local.userSettings.sidechannelNames['2']).toBe('Drums #');
    appController.setSidechannelDisplayName('2', '#');
    expect(appState.local.userSettings.sidechannelNames['2']).toBeUndefined();
    appController.setSidechannelDisplayName('2', '  ');
    expect(appState.local.userSettings.sidechannelNames['2']).toBeUndefined();
  });
});
