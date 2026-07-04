import { describe, it, expect } from 'vitest';
import { decideMode } from './resolume-mode';

describe('decideMode', () => {
  it('bare URL defaults to barrel at the fixed shared-server port', () => {
    expect(decideMode('')).toEqual({ mode: 'barrel', barrelUrl: 'ws://localhost:8081' });
  });

  it('?playground enters the playground', () => {
    expect(decideMode('?playground').mode).toBe('playground');
  });

  it('?barrel stays as an explicit barrel form', () => {
    expect(decideMode('?barrel')).toEqual({ mode: 'barrel', barrelUrl: 'ws://localhost:8081' });
  });

  it('?barrel=ws://host:port overrides the server URL', () => {
    expect(decideMode('?barrel=ws://vjbox:9000').barrelUrl).toBe('ws://vjbox:9000');
  });

  it('?playground wins over ?barrel', () => {
    expect(decideMode('?playground&barrel=ws://vjbox:9000').mode).toBe('playground');
  });

  it('unrelated params leave the default barrel mode intact', () => {
    expect(decideMode('?foo=1&bar').mode).toBe('barrel');
  });
});
