// Fake Resolume composition data provider.
// Provides a static composition with 4 clips assigned to channels 0-3.

const CLIPS = [
  { id: 100n, name: 'Clip A', channel: 0, connected: true },
  { id: 101n, name: 'Clip B', channel: 1, connected: true },
  { id: 102n, name: 'Clip C', channel: 2, connected: true },
  { id: 103n, name: 'Clip D', channel: 3, connected: true },
];

export function getClipCount(): number {
  return CLIPS.length;
}

export function getClipChannel(index: number): number {
  if (index < 0 || index >= CLIPS.length) return -1;
  return CLIPS[index].channel;
}

export function getClipId(index: number): bigint {
  if (index < 0 || index >= CLIPS.length) return 0n;
  return CLIPS[index].id;
}

export function getClipConnected(index: number): number {
  if (index < 0 || index >= CLIPS.length) return 0;
  return CLIPS[index].connected ? 1 : 0;
}

export function getClipName(index: number): string {
  if (index < 0 || index >= CLIPS.length) return '';
  return CLIPS[index].name;
}

export function getBpm(): number {
  return 120;
}
