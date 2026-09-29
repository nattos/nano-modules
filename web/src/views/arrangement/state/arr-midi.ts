/**
 * MIDI in the arrangement — binds the app-level MIDI controller (the device
 * library, Web MIDI, simulation) to THIS page's document and engine.
 *
 *   - device wires are read from the composition's sketches (every lane and
 *     clip, sequence interiors included), not the sketch editor's;
 *   - the lowered value table goes to the worker engine; the native
 *     compositor instead gets the library + on-screen simulation over the
 *     bridge and reads CoreMIDI itself (CompEngine.mirrorMidi);
 *   - the table is re-lowered after each document ship (a wire edit changes
 *     which controls are read) — an explicit call, never a reaction.
 *
 * Only an ENABLED device placement's wires survive the engine's build, so
 * values for parked or un-included devices are harmless.
 */

import { midiController } from '../../../state/midi-controller';
import { compositionSketches } from '../model/composition';
import { engineBridge } from '../engine/engine-bridge';
import { store } from './store';

let booted = false;

export async function bootArrangementMidi(): Promise<void> {
  if (booted) return;
  booted = true;
  midiController.bindSketchSource(() => compositionSketches(store.composition));
  midiController.bindEnginePush((json) => engineBridge.setExternalScalars(json));
  engineBridge.addDocShippedListener(() => midiController.pushExternalScalars());
  try {
    await midiController.loadLibrary();
  } catch (err) {
    console.warn('[arr-midi] failed to load the MIDI device library', err);
  }
  // After the load: binding mirrors the library at once, and a mirror of the
  // not-yet-loaded (empty) library would be ignored by the compositor anyway.
  midiController.bindBridge({
    library: (instances) => engineBridge.mirrorMidi('library', instances),
    sim: (table) => engineBridge.mirrorMidi('sim', table),
  });
}
