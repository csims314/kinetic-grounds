import { describe, expect, it } from 'vitest';
import { Vector2 } from 'three';
import { clamp01, damp, moveTowardVector2, shortestAngleDelta, smoothstep01 } from './math';

describe('locomotion math', () => {
  it('takes the shortest path across the angle wrap', () => {
    const delta = shortestAngleDelta((179 * Math.PI) / 180, (-179 * Math.PI) / 180);
    expect(delta).toBeCloseTo((2 * Math.PI) / 180, 6);
  });

  it('moves planar velocity without overshooting', () => {
    const velocity = new Vector2(0, 0);
    moveTowardVector2(velocity, new Vector2(3, 4), 2);
    expect(velocity.length()).toBeCloseTo(2);
    moveTowardVector2(velocity, new Vector2(3, 4), 10);
    expect(velocity.x).toBeCloseTo(3);
    expect(velocity.y).toBeCloseTo(4);
  });

  it('keeps damp and easing functions bounded', () => {
    expect(damp(0, 1, 10, 1 / 60)).toBeGreaterThan(0);
    expect(damp(0, 1, 10, 1 / 60)).toBeLessThan(1);
    expect(clamp01(-2)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(smoothstep01(0.5)).toBeCloseTo(0.5);
  });
});
