/**
 * The MASTER output switch: whether anything this show outputs actually
 * leaves the machine — displays on their screens, lights on the wire. OFF at
 * every launch and never persisted: a show opens, and nothing projects or
 * transmits until someone turns output on (the Devices panel's header). ⌘⇧D
 * ("Disable Output", as in Resolume) turns it off — from the page, or from the
 * compositor while an output window is in front (it closes them itself and
 * reports `disableOutput`).
 *
 * Each output keeps its own on/off (a show edit); this sits above them all.
 * Identify and light test patterns still work while it's off — each is an
 * explicit, momentary request.
 *
 * UI state, not the document: changes reach the engine through the light and
 * display plans, which read it when they're built (arr-lights / arr-displays
 * re-push on a change — an explicit listener, not a reaction).
 */

import { makeObservable, observable, action } from 'mobx';

class OutputMaster {
  armed = false;
  private listeners = new Set<() => void>();

  constructor() {
    makeObservable<OutputMaster, never>(this, { armed: observable, set: action });
  }

  set(on: boolean): void {
    if (this.armed === on) return;
    this.armed = on;
    for (const fn of this.listeners) fn();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const outputMaster = new OutputMaster();
