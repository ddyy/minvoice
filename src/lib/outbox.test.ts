import { describe, expect, it } from 'vitest';
import { backoffMinutes, MAX_OUTBOX_ATTEMPTS } from './outbox';

describe('backoffMinutes', () => {
  it('doubles from 5 minutes', () => {
    expect(backoffMinutes(1)).toBe(5);
    expect(backoffMinutes(2)).toBe(10);
    expect(backoffMinutes(3)).toBe(20);
    expect(backoffMinutes(4)).toBe(40);
  });

  it('caps at 6 hours from the attempt limit on', () => {
    expect(backoffMinutes(7)).toBe(320); // last uncapped step
    expect(backoffMinutes(MAX_OUTBOX_ATTEMPTS)).toBe(360);
    expect(backoffMinutes(100)).toBe(360);
  });

  it('tolerates zero/negative attempt counts', () => {
    expect(backoffMinutes(0)).toBe(5);
    expect(backoffMinutes(-1)).toBe(5);
  });
});

