/**
 * Barrel of every custom inspector registration (self-registering side-effect
 * imports). Importing this ONCE runs every `editorRegistry.register()`, so a
 * custom inspector appears in EVERY UI entry point — the sketch shell's edit-tab
 * AND the effects IDE's project editor.
 *
 * Add new inspectors HERE, not per entry point. The registrations used to be
 * listed separately in edit-tab.ts and ide-project-editor.ts, and the lists
 * drifted — which silently dropped mod.envelope (and brightness_contrast) from
 * the IDE. A single barrel makes that impossible.
 */

import './brightness-contrast-inspector';
import './shape-fold-inspector';
import './phase-fold-inspector';
import './spectral-lfo-inspector';
import './envelope-inspector';
import './paramlinker-editor';
