import { describe, it, expect } from 'vitest';
import { setupStatuses, resolumeApiPort, type SetupInput } from './resolume-setup';

const base: SetupInput = {
  remoteEnabled: true,
  probe: 'closed',
  plugin: null,
  server: null,
  liveInstances: 0,
  compositionInstances: 0,
  appRoot: null,
  barrelUrl: 'ws://localhost:8081',
  barrelMode: false,
  barrelConnection: 'closed',
};

const connected = (over: Partial<SetupInput> = {}): SetupInput => ({
  ...base,
  probe: 'open',
  plugin: { path: '/Apps/Nano.app/Contents/Resources/nano/ffgl/NanoBarrel.bundle',
            resourceRoot: '/Apps/Nano.app/Contents/Resources/nano' },
  server: { resolumeUrl: 'ws://127.0.0.1:8080/api/v1', resolumeConnected: true, bridgePort: 8081 },
  ...over,
});

describe('setupStatuses', () => {
  it('is all-pending with nothing running', () => {
    const s = setupStatuses(base);
    expect(s.plugin.state).toBe('pending');
    expect(s.webserver.state).toBe('pending');
    expect(s.instance.state).toBe('pending');
    expect(s.connect.state).toBe('pending');
    expect(s.plugin.detail).toContain('ws://localhost:8081');
  });

  it('blames the kill-switch rather than the server when remote is off', () => {
    expect(setupStatuses({ ...base, remoteEnabled: false }).plugin.detail)
      .toBe('Resolume Remote is off.');
  });

  it('checks the plugin off once the server reports a path', () => {
    const s = setupStatuses(connected());
    expect(s.plugin.state).toBe('ok');
    expect(s.plugin.detail).toContain('NanoBarrel.bundle');
  });

  // The whole point of reporting the path: Resolume happily loads a stale copy
  // and renders with a different build of every effect, silently.
  it('warns when Resolume loaded a plugin resolving a DIFFERENT resource root', () => {
    const s = setupStatuses(connected({ appRoot: '/Apps/Nano.app/Contents/Resources/nano' }));
    expect(s.plugin.state).toBe('ok');

    const stale = setupStatuses(connected({
      appRoot: '/Apps/Nano.app/Contents/Resources/nano',
      plugin: { path: '/Users/me/Documents/Resolume/Extra Effects/NanoBarrel.bundle',
                resourceRoot: '/Users/me/old-build' },
    }));
    expect(stale.plugin.state).toBe('warn');
    expect(stale.plugin.detail).toContain('/Users/me/old-build');
  });

  // A plugin copied OUT of the app still resolves back to the app's resources
  // through the install record. Same effects; not a problem.
  it('accepts a copied-out plugin that resolves the same root', () => {
    const s = setupStatuses(connected({
      appRoot: '/Apps/Nano.app/Contents/Resources/nano/',
      plugin: { path: '/Users/me/Documents/Resolume/Extra Effects/NanoBarrel.bundle',
                resourceRoot: '/Apps/Nano.app/Contents/Resources/nano' },
    }));
    expect(s.plugin.state).toBe('ok');
  });

  it('has nothing to compare in a browser', () => {
    const s = setupStatuses(connected({
      appRoot: null,
      plugin: { path: '/somewhere/NanoBarrel.bundle', resourceRoot: '/elsewhere' },
    }));
    expect(s.plugin.state).toBe('ok');
  });

  it('separates "Resolume is off" from "its webserver is off"', () => {
    expect(setupStatuses(base).webserver.detail).toBe('');
    const off = setupStatuses(connected({
      server: { resolumeUrl: 'ws://127.0.0.1:8080/api/v1', resolumeConnected: false },
    }));
    expect(off.webserver.state).toBe('pending');
    expect(off.webserver.detail).toContain('8080');
    expect(setupStatuses(connected()).webserver.state).toBe('ok');
  });

  // The trap the checklist exists to explain.
  it('distinguishes "in the composition" from "actually playing"', () => {
    const unlaunched = setupStatuses(connected({ compositionInstances: 2, liveInstances: 0 }));
    expect(unlaunched.instance.state).toBe('pending');
    expect(unlaunched.instance.detail).toContain('trigger the clip');

    const live = setupStatuses(connected({ compositionInstances: 2, liveInstances: 1 }));
    expect(live.instance.state).toBe('ok');
    expect(live.instance.detail).toBe('1 instance running.');
  });

  it('only checks off the connection in Live mode with an open socket', () => {
    expect(setupStatuses(connected({ barrelMode: false })).connect.state).toBe('pending');
    expect(setupStatuses(connected({ barrelMode: true, barrelConnection: 'connecting' })).connect.state).toBe('pending');
    expect(setupStatuses(connected({ barrelMode: true, barrelConnection: 'open' })).connect.state).toBe('ok');
  });
});

describe('resolumeApiPort', () => {
  it('reads the port out of the API url', () => {
    expect(resolumeApiPort('ws://127.0.0.1:8080/api/v1')).toBe('8080');
    expect(resolumeApiPort('ws://127.0.0.1:9000/api/v1')).toBe('9000');
    expect(resolumeApiPort(undefined)).toBe('');
    expect(resolumeApiPort('not a url')).toBe('');
  });
});
