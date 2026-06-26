// @vitest-environment happy-dom
/**
 * Component tests for <editable-text> (the shared text-input primitive): the
 * live `input` event, terminal `commit`/`cancel` semantics, single-fire guard,
 * imperative value reflection, and the IME composition guard.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import './editable-text';
import type { EditableText } from './editable-text';

async function mount(value = '', multiline = false): Promise<EditableText> {
  const el = document.createElement('editable-text') as EditableText;
  el.value = value;
  el.multiline = multiline;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

function $ctrl(el: EditableText) {
  return el.renderRoot.querySelector('.control') as HTMLInputElement | HTMLTextAreaElement;
}

describe('<editable-text>', () => {
  let el: EditableText;
  afterEach(() => { el?.remove(); });

  it('reflects the external value into the control', async () => {
    el = await mount('hello');
    expect($ctrl(el).value).toBe('hello');
  });

  it('emits a live `input` event (detail = current value) per keystroke', async () => {
    el = await mount('');
    const onInput = vi.fn();
    el.addEventListener('input', (e) => onInput((e as CustomEvent).detail));
    const c = $ctrl(el);
    c.value = 'ab';
    c.dispatchEvent(new InputEvent('input', { bubbles: true }));
    expect(onInput).toHaveBeenCalledExactlyOnceWith('ab');
  });

  it('Enter commits (single-line); blur after Enter does not double-fire', async () => {
    el = await mount('x');
    const onCommit = vi.fn();
    el.addEventListener('commit', (e) => onCommit((e as CustomEvent).detail));
    const c = $ctrl(el);
    c.value = 'xy';
    c.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    c.dispatchEvent(new FocusEvent('blur'));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('xy');
  });

  it('blur commits when Enter did not', async () => {
    el = await mount('x');
    const onCommit = vi.fn();
    el.addEventListener('commit', (e) => onCommit((e as CustomEvent).detail));
    const c = $ctrl(el);
    c.value = 'blurred';
    c.dispatchEvent(new FocusEvent('blur'));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('blurred');
  });

  it('Escape cancels (reverts control) without committing', async () => {
    el = await mount('orig');
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    el.addEventListener('commit', onCommit);
    el.addEventListener('cancel', onCancel);
    const c = $ctrl(el);
    c.value = 'typed';
    c.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onCommit).not.toHaveBeenCalled();
    expect(c.value).toBe('orig'); // reverted
  });

  it('a fresh focus session resets the single-fire guard', async () => {
    el = await mount('x');
    const onCommit = vi.fn();
    el.addEventListener('commit', onCommit);
    const c = $ctrl(el);
    c.dispatchEvent(new FocusEvent('blur')); // session 1 commit
    c.dispatchEvent(new FocusEvent('focus')); // new session
    c.dispatchEvent(new FocusEvent('blur')); // session 2 commit
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it('multiline Enter does NOT commit (inserts a newline)', async () => {
    el = await mount('line', true);
    const onCommit = vi.fn();
    el.addEventListener('commit', onCommit);
    const c = $ctrl(el);
    expect(c.tagName).toBe('TEXTAREA');
    c.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onCommit).not.toHaveBeenCalled();
  });

  describe('IME composition guard', () => {
    it('drops intermediate input during composition, commits once on end', async () => {
      el = await mount('');
      const onInput = vi.fn();
      el.addEventListener('input', (e) => onInput((e as CustomEvent).detail));
      const c = $ctrl(el);
      c.dispatchEvent(new CompositionEvent('compositionstart'));
      // Mid-composition input events must NOT round-trip.
      c.value = 'ni';
      c.dispatchEvent(new InputEvent('input', { bubbles: true }));
      c.value = 'に';
      c.dispatchEvent(new InputEvent('input', { bubbles: true }));
      expect(onInput).not.toHaveBeenCalled();
      // compositionend commits the final string exactly once.
      c.value = '日本';
      c.dispatchEvent(new CompositionEvent('compositionend'));
      expect(onInput).toHaveBeenCalledExactlyOnceWith('日本');
    });

    it('does not clobber the control value via reflection while composing', async () => {
      el = await mount('A');
      const c = $ctrl(el);
      c.dispatchEvent(new CompositionEvent('compositionstart'));
      c.value = 'half-composed';
      // An external value change + re-render must not overwrite the live buffer.
      el.value = 'B';
      await el.updateComplete;
      expect(c.value).toBe('half-composed');
    });
  });
});
