import { describe, it, expect } from 'vitest';
import { laneKey, splitLane, LANE_SEP } from './field-anchor-lookup';

describe('lane anchor keys', () => {
  it('round-trips a lane', () => {
    expect(laneKey('translate', 1)).toBe(`translate${LANE_SEP}1`);
    expect(splitLane('translate#1')).toEqual({ field: 'translate', lane: 1 });
  });

  it('an absent lane means the whole field', () => {
    expect(laneKey('translate')).toBe('translate');
    expect(splitLane('translate')).toEqual({ field: 'translate' });
  });

  it('keeps struct leaf paths intact', () => {
    // `/` is the struct-leaf separator, which is exactly why it could not be
    // the lane separator too.
    expect(splitLane('sdf_field/radius')).toEqual({ field: 'sdf_field/radius' });
    expect(splitLane('sdf_field/radius#2'))
      .toEqual({ field: 'sdf_field/radius', lane: 2 });
  });

  it('a non-numeric suffix is part of the name, not a lane', () => {
    expect(splitLane('weird#name')).toEqual({ field: 'weird#name' });
    expect(splitLane('weird#-1')).toEqual({ field: 'weird#-1' });
    expect(splitLane('weird#1.5')).toEqual({ field: 'weird#1.5' });
  });

  it('reads the LAST separator, so a lane wins over a name containing one', () => {
    expect(splitLane('weird#name#3')).toEqual({ field: 'weird#name', lane: 3 });
  });
});
