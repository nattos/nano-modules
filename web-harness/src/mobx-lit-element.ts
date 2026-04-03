import { LitElement } from 'lit';
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

  disconnectedCallback() {
    super.disconnectedCallback();
    this._mobxDisposer?.();
    this._mobxDisposer = null;
  }
}
