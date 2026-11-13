import { describe, it, expect } from 'vitest';
import { parsePmsetSleepMinutes } from './pmset.js';

const sample = (sleepLine: string) => [
  'System-wide power settings:',
  ' SleepDisabled\t\t0',
  'Currently in use:',
  ' standby              0',
  ' Sleep On Power Button 1',
  ' hibernatefile        /var/vm/sleepimage',
  ' powernap             1',
  ' disksleep            10',
  sleepLine,
  ' displaysleep         10',
  ' womp                 1',
].join('\n');

describe('parsePmsetSleepMinutes', () => {
  it('reads the system sleep timer, ignoring display/disk sleep', () => {
    expect(parsePmsetSleepMinutes(sample(' sleep                1'))).toBe(1);
  });
  it('reads 0 (never sleeps), with or without a "prevented by" note', () => {
    expect(parsePmsetSleepMinutes(sample(' sleep                0'))).toBe(0);
    expect(parsePmsetSleepMinutes(sample(' sleep                0 (sleep prevented by powerd)'))).toBe(0);
  });
  it('returns null when there is no sleep line', () => {
    expect(parsePmsetSleepMinutes('nothing useful here')).toBeNull();
  });
});
