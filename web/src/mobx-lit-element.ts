import { LitElement, PropertyValues } from 'lit';
import { autorun, IReactionDisposer } from 'mobx';

/**
 * LitElement base class that auto-reacts to MobX observable changes.
 * Access observables in render() and the component re-renders when they change.
 */
export class MobxLitElement extends LitElement {
  private _mobxDisposer: IReactionDisposer | null = null;
  private _cachedTemplate: unknown = null;
  private _originalRender: (() => unknown) | null = null;

  connectedCallback() {
    super.connectedCallback();
    if (!this._originalRender) {
      this._originalRender = this.render.bind(this);
    }
    const origRender = this._originalRender;

    this.render = () => {
      if (this._cachedTemplate) {
        const t = this._cachedTemplate;
        this._cachedTemplate = null;
        return t;
      }

      let result: unknown = null;
      let isSync = true;

      this._mobxDisposer?.();
      this._mobxDisposer = autorun(() => {
        const r = origRender();
        if (isSync) {
          result = r;
        } else {
          this._cachedTemplate = r;
          this.requestUpdate();
        }
      });

      isSync = false;
      return result;
    };
  }

  /**
   * A Lit reactive-property change (e.g. `.clip=${other}` when the parent reuses
   * this element for a different item) must re-render FRESH from the current
   * properties. The autorun's `_cachedTemplate` was computed for the PREVIOUS
   * properties, so serving it here would render stale (the classic "list desyncs
   * until you click" bug). Autorun-driven updates carry no changed properties, so
   * they still use the cache. `changed.size === 0` on the very first update too,
   * which is fine — there's nothing cached yet.
   */
  protected update(changed: PropertyValues): void {
    if (changed.size > 0) this._cachedTemplate = null;
    super.update(changed);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._mobxDisposer?.();
    this._mobxDisposer = null;
  }
}
