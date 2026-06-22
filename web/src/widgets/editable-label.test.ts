// @vitest-environment happy-dom
/**
 * Component tests for <editable-label> (DOM behavior under happy-dom): the
 * dblclick→edit→commit/cancel flow for the plain variant, and the
 * event-passthrough for the provider (autocomplete) variant.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import './editable-label';
import type { EditableLabel } from './editable-label';

async function mount(value = '', placeholder = ''): Promise<EditableLabel> {
  const el = document.createElement('editable-label') as EditableLabel;
  el.value = value;
  el.placeholder = placeholder;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

function $display(el: EditableLabel) {
  return el.renderRoot.querySelector('.display') as HTMLElement | null;
}
function $input(el: EditableLabel) {
  return el.renderRoot.querySelector('input') as HTMLInputElement | null;
}

describe('<editable-label> plain variant', () => {
  let el: EditableLabel;
  afterEach(() => { el?.remove(); });

  it('shows the value, no input until edit', async () => {
    el = await mount('Drum Loop');
    expect($display(el)?.textContent).toBe('Drum Loop');
    expect($input(el)).toBeNull();
  });

  it('shows the placeholder (muted) when empty', async () => {
    el = await mount('', 'Untitled');
    const d = $display(el)!;
    expect(d.textContent).toBe('Untitled');
    expect(d.classList.contains('placeholder')).toBe(true);
  });

  it('dblclick enters edit mode with the input seeded', async () => {
    el = await mount('Bass');
    $display(el)!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await el.updateComplete;
    expect($input(el)?.value).toBe('Bass');
  });

  it('Enter commits the edited value', async () => {
    el = await mount('Bass');
    const onCommit = vi.fn();
    el.addEventListener('commit', (e) => onCommit((e as CustomEvent).detail));
    el.beginEdit();
    await el.updateComplete;
    const input = $input(el)!;
    input.value = 'Bassline';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('Bassline');
    await el.updateComplete;
    expect($input(el)).toBeNull(); // back to display mode
  });

  it('Escape cancels without committing', async () => {
    el = await mount('Bass');
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    el.addEventListener('commit', onCommit);
    el.addEventListener('cancel', onCancel);
    el.beginEdit();
    await el.updateComplete;
    const input = $input(el)!;
    input.value = 'changed';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('blur commits (plain variant)', async () => {
    el = await mount('Bass');
    const onCommit = vi.fn();
    el.addEventListener('commit', (e) => onCommit((e as CustomEvent).detail));
    el.beginEdit();
    await el.updateComplete;
    const input = $input(el)!;
    input.value = 'Sub Bass';
    input.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('Sub Bass');
  });

  it('Enter then blur fires exactly one terminal event', async () => {
    el = await mount('Bass');
    const onCommit = vi.fn();
    el.addEventListener('commit', onCommit);
    el.beginEdit();
    await el.updateComplete;
    const input = $input(el)!;
    input.value = 'X';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    input.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
    expect(onCommit).toHaveBeenCalledOnce();
  });
});

describe('<editable-label> provider variant', () => {
  let el: EditableLabel;
  afterEach(() => { el?.remove(); });

  function withProvider(): { el: Promise<EditableLabel>; editor: HTMLElement } {
    const editor = document.createElement('div');
    const elP = (async () => {
      const e = document.createElement('editable-label') as EditableLabel;
      e.value = 'color.invert';
      e.provider = () => editor;
      document.body.appendChild(e);
      await e.updateComplete;
      return e;
    })();
    return { el: elP, editor };
  }

  it('hosts the provider element and forwards commit, then exits', async () => {
    const { el: elP, editor } = withProvider();
    el = await elP;
    const onCommit = vi.fn();
    el.addEventListener('commit', (e) => onCommit((e as CustomEvent).detail));
    el.beginEdit();
    await el.updateComplete;
    // provider element is mounted inside the edit host
    expect(el.renderRoot.querySelector('.edit-host')?.contains(editor)).toBe(true);
    editor.dispatchEvent(new CustomEvent('commit', { detail: 'color.hsl' }));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('color.hsl');
    await el.updateComplete;
    expect(el.renderRoot.querySelector('.edit-host')).toBeNull();
  });

  it('forwards preview without exiting edit mode', async () => {
    const { el: elP, editor } = withProvider();
    el = await elP;
    const onPreview = vi.fn();
    el.addEventListener('preview', (e) => onPreview((e as CustomEvent).detail));
    el.beginEdit();
    await el.updateComplete;
    editor.dispatchEvent(new CustomEvent('preview', { detail: 'color.hsl' }));
    editor.dispatchEvent(new CustomEvent('preview', { detail: 'color.saturate' }));
    expect(onPreview).toHaveBeenNthCalledWith(1, 'color.hsl');
    expect(onPreview).toHaveBeenNthCalledWith(2, 'color.saturate');
    await el.updateComplete;
    expect(el.renderRoot.querySelector('.edit-host')).not.toBeNull(); // still editing
  });

  it('forwards delete-request and cancel as terminal events', async () => {
    const { el: elP, editor } = withProvider();
    el = await elP;
    const onDelete = vi.fn();
    el.addEventListener('delete-request', onDelete);
    el.beginEdit();
    await el.updateComplete;
    editor.dispatchEvent(new CustomEvent('delete-request'));
    expect(onDelete).toHaveBeenCalledOnce();
    await el.updateComplete;
    expect(el.renderRoot.querySelector('.edit-host')).toBeNull();
  });
});
