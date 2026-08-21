/**
 * Barrel of every custom inspector registration (self-registering side-effect
 * imports). Importing this ONCE runs every `editorRegistry.register()`, so a
 * custom inspector appears in EVERY UI entry point — the sketch shell's edit-tab
 * AND the effects IDE's project editor.
 *
 * Add new inspectors HERE, not per entry point. The registrations used to be
 * listed separately in edit-tab.ts and ide-project-editor.ts, and the lists
 * drifted — which silently dropped mod.shaper.envelope from the IDE. A single barrel
 * makes that impossible.
 */

import './blend-inspector';
import './shape-fold-inspector';
import './brutal-fold-inspector';
import './phase-fold-inspector';
import './spectral-lfo-inspector';
import './mod-spectral-inspector';
import './envelope-inspector';
import './envelope-warp-inspector';
import './adsr-inspector';
import './paramlinker-editor';
import './sidechannel-inspector';
import './nanolooper-inspector';
import './lens-inspector';
import './input-count-options';
