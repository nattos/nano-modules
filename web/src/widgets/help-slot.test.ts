// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import './help-slot';
import type { HelpSlot } from './help-slot';
import type { FieldBinding } from './field-editor';
import { fieldDocsStore } from '../state/field-docs-store';

// A minimal help binding. `helpMode`, `moduleType`, and getHelp/setHelp drive the
// three-layer resolution; the rest are inert stubs to satisfy FieldBinding.
function binding(opts: {
  helpMode?: boolean;
  moduleType?: string;
  local?: { scope?: 'global' | 'local'; text?: string };
}): FieldBinding & { helpWrites: Array<{ scope?: string; text?: string }> } {
  const helpWrites: Array<{ scope?: string; text?: string }> = [];
  return {
    helpWrites,
    instanceKey: 'x',
    moduleType: opts.moduleType ?? 'test.effect',
    helpMode: opts.helpMode ?? true,
    getValue: () => 0,
    setValue: () => {},
    beginContinuousEdit: () => ({ update: () => {}, accept: () => {}, cancel: () => {} }),
    getHelp: () => opts.local,
    setHelp: (_p, patch) => helpWrites.push(patch),
  };
}

async function mount(setup: (el: HelpSlot) => void): Promise<HelpSlot> {
  const el = document.createElement('help-slot') as HelpSlot;
  setup(el);
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

const body = (el: HelpSlot) => el.renderRoot.querySelector('.help-body') as HTMLElement | null;

describe('<help-slot> scope resolution', () => {
  it('collapses to nothing when help mode is off', async () => {
    const el = await mount((e) => {
      e.path = 'intro';
      e.default = 'hello **world**';
      e.binding = binding({ helpMode: false });
    });
    expect(body(el)).toBeNull();
    expect(el.renderRoot.querySelector('textarea')).toBeNull();
  });

  it('shows the effect default (rendered markdown) when there is no override', async () => {
    const el = await mount((e) => {
      e.path = 'intro';
      e.default = 'hello **world**';
      e.binding = binding({ helpMode: true, moduleType: 'test.default' });
    });
    const b = body(el)!;
    expect(b).not.toBeNull();
    expect(b.textContent).toContain('hello');
    expect(b.querySelector('strong')?.textContent).toBe('world');   // marked rendered
  });

  it('local scope shows the sketch-local text over the default', async () => {
    const el = await mount((e) => {
      e.path = 'intro';
      e.default = 'THE DEFAULT';
      e.binding = binding({
        helpMode: true, moduleType: 'test.local',
        local: { scope: 'local', text: 'THE LOCAL OVERRIDE' },
      });
    });
    expect(body(el)!.textContent).toContain('THE LOCAL OVERRIDE');
    expect(body(el)!.textContent).not.toContain('THE DEFAULT');
  });

  it('global scope shows the browser-global override over the default', async () => {
    fieldDocsStore.set('test.global', 'intro', 'THE GLOBAL OVERRIDE');
    const el = await mount((e) => {
      e.path = 'intro';
      e.default = 'THE DEFAULT';
      // No local entry ⇒ scope defaults to 'global'.
      e.binding = binding({ helpMode: true, moduleType: 'test.global' });
    });
    expect(body(el)!.textContent).toContain('THE GLOBAL OVERRIDE');
    expect(body(el)!.textContent).not.toContain('THE DEFAULT');
  });

  it("global scope ignores a local text (only 'local' scope surfaces it)", async () => {
    const el = await mount((e) => {
      e.path = 'intro';
      e.default = 'THE DEFAULT';
      e.binding = binding({
        helpMode: true, moduleType: 'test.globalscope',
        local: { scope: 'global', text: 'SHOULD NOT SHOW' },
      });
    });
    expect(body(el)!.textContent).toContain('THE DEFAULT');
    expect(body(el)!.textContent).not.toContain('SHOULD NOT SHOW');
  });

  it('renders a "double-click to add" placeholder when there is no text anywhere', async () => {
    const el = await mount((e) => {
      e.path = '@group/empty';
      e.default = '';
      e.binding = binding({ helpMode: true, moduleType: 'test.empty' });
    });
    const b = body(el)!;
    expect(b.classList.contains('placeholder')).toBe(true);
    expect(b.textContent).toContain('Double-click');
  });
});

describe('<help-slot> editing', () => {
  it('double-click opens the editor seeded with the shown text', async () => {
    const el = await mount((e) => {
      e.path = 'intro';
      e.default = 'SEED TEXT';
      e.binding = binding({ helpMode: true, moduleType: 'test.edit' });
    });
    body(el)!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await el.updateComplete;
    const ta = el.renderRoot.querySelector('textarea') as HTMLTextAreaElement;
    expect(ta).not.toBeNull();
    expect(ta.value).toBe('SEED TEXT');
  });

  it('switching the segment to Local records the scope selection in the sketch', async () => {
    const b = binding({ helpMode: true, moduleType: 'test.switch' });
    const el = await mount((e) => {
      e.path = 'intro';
      e.default = 'SEED';
      e.binding = b;
    });
    body(el)!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await el.updateComplete;
    // The selector is a <field-tab-bar>; its buttons live in its own shadow root.
    const tabBar = el.renderRoot.querySelector('field-tab-bar') as any;
    await tabBar.updateComplete;
    const btns = [...tabBar.renderRoot.querySelectorAll('button')] as HTMLButtonElement[];
    expect(btns.map((x) => x.textContent?.trim())).toEqual(['Global', 'Local']);
    btns[1].click();   // → Local
    await el.updateComplete;
    expect(b.helpWrites.some((w) => w.scope === 'local')).toBe(true);
  });

  it('switching to Local with no local note yields a blank "Notes go here" editor', async () => {
    const el = await mount((e) => {
      e.path = 'intro';
      e.default = 'THE GLOBAL DEFAULT';   // local must NOT inherit this
      e.binding = binding({ helpMode: true, moduleType: 'test.blanklocal' });
    });
    body(el)!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await el.updateComplete;
    const tabBar = el.renderRoot.querySelector('field-tab-bar') as any;
    await tabBar.updateComplete;
    (tabBar.renderRoot.querySelectorAll('button')[1] as HTMLButtonElement).click();  // → Local
    await el.updateComplete;
    const ta = el.renderRoot.querySelector('textarea') as HTMLTextAreaElement;
    expect(ta.value).toBe('');                       // blank, not the global default
    expect(ta.placeholder).toBe('Notes go here');
  });
});
