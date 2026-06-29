// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import './field-tab-bar';
import './field-toggle';
import './scalar-slider';
import type { FieldTabBar } from './field-tab-bar';
import type { FieldToggle } from './field-toggle';
import type { ScalarSlider } from './scalar-slider';
import type { FieldBinding } from './field-editor';

// A minimal multi-edit binding: reports `mixed` + `inUse`, records writes.
function binding(opts: { value?: any; mixed?: boolean; inUse?: unknown[] }): FieldBinding & { writes: any[] } {
  const writes: any[] = [];
  return {
    writes,
    instanceKey: 'x',
    getValue: () => opts.value ?? 0,
    setValue: (_f, v) => writes.push(v),
    beginContinuousEdit: (_f, v) => { writes.push(v); return { update: (x) => writes.push(x), accept: () => {}, cancel: () => {} }; },
    isMixed: () => !!opts.mixed,
    inUseValues: () => opts.inUse ?? [],
  };
}

async function mount<T extends HTMLElement>(tag: string, setup: (el: T) => void): Promise<T> {
  const el = document.createElement(tag) as T;
  setup(el);
  document.body.appendChild(el);
  await (el as any).updateComplete;
  return el;
}

describe('<field-tab-bar> multi-edit', () => {
  it('mixed → no option active; in-use options get the gray "inuse" mark', async () => {
    const el = await mount<FieldTabBar>('field-tab-bar', (e) => {
      e.fieldPath = 'mode';
      e.options = [{ label: 'A', value: 0 }, { label: 'B', value: 1 }, { label: 'C', value: 2 }];
      e.binding = binding({ value: 0, mixed: true, inUse: [0, 2] });
    });
    const btns = [...el.renderRoot.querySelectorAll('button')] as HTMLButtonElement[];
    expect(btns.some((b) => b.hasAttribute('active'))).toBe(false);
    expect(btns[0].hasAttribute('inuse')).toBe(true);  // value 0 in use
    expect(btns[1].hasAttribute('inuse')).toBe(false); // value 1 not in use
    expect(btns[2].hasAttribute('inuse')).toBe(true);  // value 2 in use
  });

  it('not mixed → the matching option is active (normal single-value behavior)', async () => {
    const el = await mount<FieldTabBar>('field-tab-bar', (e) => {
      e.fieldPath = 'mode';
      e.options = [{ label: 'A', value: 0 }, { label: 'B', value: 1 }];
      e.binding = binding({ value: 1, mixed: false });
    });
    const btns = [...el.renderRoot.querySelectorAll('button')] as HTMLButtonElement[];
    expect(btns[0].hasAttribute('active')).toBe(false);
    expect(btns[1].hasAttribute('active')).toBe(true);
  });

  it('picking an option writes that value to all', async () => {
    const b = binding({ value: 0, mixed: true, inUse: [0, 2] });
    const el = await mount<FieldTabBar>('field-tab-bar', (e) => {
      e.fieldPath = 'mode';
      e.options = [{ label: 'A', value: 0 }, { label: 'B', value: 1 }];
      e.binding = b;
    });
    (el.renderRoot.querySelectorAll('button')[1] as HTMLButtonElement).click();
    expect(b.writes).toEqual([1]);
  });
});

describe('<field-toggle> multi-edit', () => {
  it('mixed → shows "many", neither active; click aligns to ON', async () => {
    const b = binding({ value: 0, mixed: true });
    const el = await mount<FieldToggle>('field-toggle', (e) => {
      e.fieldPath = 'on'; e.binding = b;
    });
    const btn = el.renderRoot.querySelector('button') as HTMLButtonElement;
    expect(btn.textContent?.trim()).toBe('many');
    expect(btn.hasAttribute('active')).toBe(false);
    btn.click();
    expect(b.writes).toEqual([1]);
  });
});

describe('<scalar-slider> multi-edit', () => {
  it('mixed → value display reads "many" and the fill bar is suppressed', async () => {
    const el = await mount<ScalarSlider>('scalar-slider', (e) => {
      e.fieldPath = 'amount'; e.min = 0; e.max = 1; e.step = 0.01;
      e.binding = binding({ value: 0.5, mixed: true });
    });
    const vd = el.renderRoot.querySelector('.value-display') as HTMLElement;
    expect(vd.textContent?.trim()).toBe('many');
    expect(vd.classList.contains('mixed')).toBe(true);
    const bar = el.renderRoot.querySelector('.bar') as HTMLElement;
    expect(bar.style.width).toBe('0%');
  });
});
