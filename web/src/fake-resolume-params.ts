// Fake Resolume parameters for testing the param-linker learn mechanism.
// Based on real parameter data from the Resolume WS fixture.

export interface FakeParam {
  id: bigint;
  path: string;
  type: 'range' | 'boolean';
  value: number;
  min: number;
  max: number;
}

export const FAKE_PARAMS: FakeParam[] = [
  { id: 1000n, path: '/composition/master',                           type: 'range',   value: 1.0,  min: 0, max: 1 },
  { id: 1001n, path: '/composition/speed',                            type: 'range',   value: 1.0,  min: 0, max: 10 },
  { id: 1010n, path: '/composition/layers/1/video/opacity',           type: 'range',   value: 1.0,  min: 0, max: 1 },
  { id: 1011n, path: '/composition/layers/1/master',                  type: 'range',   value: 1.0,  min: 0, max: 1 },
  { id: 1020n, path: '/composition/layers/1/clips/1/video/opacity',   type: 'range',   value: 1.0,  min: 0, max: 1 },
  { id: 1021n, path: '/composition/layers/1/clips/1/speed',           type: 'range',   value: 1.0,  min: 0, max: 10 },
  { id: 1030n, path: '/composition/layers/2/video/opacity',           type: 'range',   value: 1.0,  min: 0, max: 1 },
  { id: 1040n, path: '/dashboard/Link 1',                             type: 'range',   value: 0.0,  min: 0, max: 1 },
  { id: 1041n, path: '/dashboard/Link 2',                             type: 'range',   value: 0.0,  min: 0, max: 1 },
  { id: 1050n, path: '/composition/bypassed',                         type: 'boolean', value: 0.0,  min: 0, max: 1 },
  { id: 1060n, path: '/audio/volume',                                 type: 'range',   value: 0.0,  min: 0, max: 1 },
];
