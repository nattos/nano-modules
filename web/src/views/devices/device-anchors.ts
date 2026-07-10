/**
 * Devices-tab cross-shadow anchor registry — the same keying-over-rect-tracker
 * pattern as the arrangement's anchor-registry.ts, scoped to the Devices
 * surface. Device surfaces register their W-mode hit zones under stable keys;
 * <device-wire-overlay> reads viewport rects by key to route wires without
 * deep shadow queries. `liveRect` self-prunes disconnected/zero-size elements
 * (hidden banks, scrolled-away cards → the wire simply isn't drawn).
 */

import { FieldLayoutManager } from '../../widgets/field-layout-manager';

const layout = new FieldLayoutManager();

export function setDeviceAnchor(key: string, el: Element | null | undefined): void {
  layout.setAnchor(key, (el as HTMLElement | null | undefined) ?? null);
}

export function deviceAnchorRect(key: string): DOMRect | null {
  return layout.liveRect(key);
}

export const DeviceAnchorKeys = {
  /** One wireable endpoint: deviceId + full endpoint field ('b0/e05/turn'). */
  control: (deviceId: string, endpoint: string) => `devctl:${deviceId}:${endpoint}`,
};
