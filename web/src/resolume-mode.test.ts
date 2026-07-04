import { describe, it, expect } from 'vitest';
import { decideMode, bannerOffer } from './resolume-mode';

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

describe('bannerOffer', () => {
  const base = {
    barrelMode: true,
    connection: 'closed' as const,
    graceElapsed: true,
    barrelDetected: false,
    dismissed: false,
  };

  it('barrel mode offers the playground only after the grace window', () => {
    expect(bannerOffer(base)).toBe('offer-playground');
    expect(bannerOffer({ ...base, graceElapsed: false })).toBeNull();
  });

  it('an open connection never offers, even with grace elapsed', () => {
    expect(bannerOffer({ ...base, connection: 'open' })).toBeNull();
  });

  it('still-connecting counts as unreachable once grace elapses', () => {
    expect(bannerOffer({ ...base, connection: 'connecting' })).toBe('offer-playground');
  });

  it('playground offers live only once a server is detected', () => {
    const pg = { ...base, barrelMode: false, connection: 'connecting' as const, graceElapsed: false };
    expect(bannerOffer(pg)).toBeNull();
    expect(bannerOffer({ ...pg, barrelDetected: true })).toBe('offer-live');
  });

  it('dismissal silences both offers', () => {
    expect(bannerOffer({ ...base, dismissed: true })).toBeNull();
    expect(bannerOffer({
      ...base, barrelMode: false, barrelDetected: true, dismissed: true,
    })).toBeNull();
  });
});
