/**
 * Thin scrollbars inside every Lit component.
 *
 * style.css sets `scrollbar-color` on :root, and that INHERITS through
 * shadow roots. `scrollbar-width` does not inherit, and a document `*` rule
 * never reaches a shadow tree, so without this every component's scroller
 * keeps full-width Windows scrollbars with arrow buttons (macOS's overlay
 * scrollbars hide the difference).
 *
 * This puts one shared rule at the FRONT of every component's styles, so
 * anything a component says about its own scrollbars (e.g. `none`) still
 * wins. It must run before the first element class is defined (definition
 * finalizes the styles), so each entry module imports it first.
 */

import { ReactiveElement, css, type CSSResultGroup, type CSSResultOrNative } from 'lit';

const scrollbars = css`
  :host, * { scrollbar-width: thin; }
`;

const base = ReactiveElement as unknown as {
  finalizeStyles(styles?: CSSResultGroup): CSSResultOrNative[];
};
const finalizeStyles = base.finalizeStyles;
base.finalizeStyles = function (this: typeof ReactiveElement, styles?: CSSResultGroup) {
  return [scrollbars, ...finalizeStyles.call(this, styles)];
};
