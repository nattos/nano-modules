export type Point = [x: number, y: number];

export enum CancelReason {
  NoChange = 'NoChange',
  UserAction = 'UserAction',
  Programmatic = 'Programmatic',
}

export class PointerDragOp {
  private isDisposed = false;
  private readonly pointerId;
  private readonly moveFunc;
  private readonly upFunc;
  private readonly cancelFunc;

  private initialThresholdReached = false;
  private readonly startX;
  private readonly startY;

  constructor(e: PointerEvent, private readonly element: HTMLElement, readonly callbacks: {
    move?: (e: PointerEvent, delta: Point) => void,
    accept?: (e: PointerEvent, delta: Point) => void,
    cancel?: (reason: CancelReason) => void,
    complete?: () => void,
    callMoveImmediately?: boolean,
    callMoveBeforeDone?: boolean,
    threshold?: number,
  }) {
    this.pointerId = e.pointerId;

    this.moveFunc = this.onPointerMove.bind(this);
    this.upFunc = this.onPointerUp.bind(this);
    this.cancelFunc = this.onPointerCancel.bind(this);
    window.addEventListener('pointermove', this.moveFunc);
    window.addEventListener('pointerup', this.upFunc);
    window.addEventListener('pointercancel', this.cancelFunc);

    this.startX = e.clientX;
    this.startY = e.clientY;

    if (this.callbacks.callMoveImmediately) {
      this.element.setPointerCapture(this.pointerId);
      this.initialThresholdReached = true;
      this.moveFunc(e);
    }
  }

  private onPointerMove(e: PointerEvent) {
    if (this.isDisposed || e.pointerId !== this.pointerId) return;
    const delta: Point = [e.clientX - this.startX, e.clientY - this.startY];
    if (!this.initialThresholdReached) {
      const deltaFromStart = Math.abs(delta[0]) + Math.abs(delta[1]);
      const threshold = this.callbacks.threshold ?? 5;
      if (deltaFromStart > threshold) {
        this.element.setPointerCapture(this.pointerId);
        this.initialThresholdReached = true;
      }
    }
    if (!this.initialThresholdReached) return;
    this.callbacks?.move?.(e, delta);
  }

  private onPointerUp(e: PointerEvent) {
    if (this.isDisposed || e.pointerId !== this.pointerId) return;
    const delta: Point = [e.clientX - this.startX, e.clientY - this.startY];
    if (this.callbacks.callMoveBeforeDone) {
      this.callbacks?.move?.(e, delta);
    }
    if (!this.initialThresholdReached) {
      this.callbacks?.cancel?.(CancelReason.NoChange);
    } else {
      this.callbacks?.accept?.(e, delta);
    }
    this.callbacks?.complete?.();
    this.finishDispose();
  }

  private onPointerCancel(e: PointerEvent) {
    if (this.isDisposed || e.pointerId !== this.pointerId) return;
    const delta: Point = [e.clientX - this.startX, e.clientY - this.startY];
    if (this.callbacks.callMoveBeforeDone) {
      this.callbacks?.move?.(e, delta);
    }
    this.callbacks?.cancel?.(CancelReason.UserAction);
    this.callbacks?.complete?.();
    this.finishDispose();
  }

  dispose() {
    if (this.isDisposed) return;
    this.callbacks?.cancel?.(CancelReason.Programmatic);
    this.callbacks?.complete?.();
    this.finishDispose();
  }

  private finishDispose() {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.element.releasePointerCapture(this.pointerId);
    window.removeEventListener('pointermove', this.moveFunc);
    window.removeEventListener('pointerup', this.upFunc);
    window.removeEventListener('pointercancel', this.cancelFunc);
  }
}
