import { describe, expect, it } from 'vitest';
import {
  cubicDecayCoefficients,
  hasContactMajority,
  isSourceFootContact,
  selectFootSupport,
  softClampExtension,
  solvePelvisReachOffset,
} from './ik';

describe('IK utilities', () => {
  it('soft-clamps extension without changing ordinary reach', () => {
    expect(softClampExtension(0.8, 1, 0.01)).toBeCloseTo(0.8);
    expect(softClampExtension(0.99, 1, 0.01)).toBeCloseTo(0.99);

    const atMaximum = softClampExtension(1, 1, 0.01);
    const farBeyond = softClampExtension(2, 1, 0.01);
    expect(atMaximum).toBeLessThan(1);
    expect(farBeyond).toBeGreaterThan(atMaximum);
    expect(farBeyond).toBeLessThanOrEqual(1);
  });

  it('decays position and velocity continuously to rest', () => {
    expect(cubicDecayCoefficients(0, 0.2)).toEqual({
      positionFromOffset: 1,
      positionFromVelocity: 0,
      velocityFromOffset: 0,
      velocityFromVelocity: 1,
    });
    expect(cubicDecayCoefficients(0.2, 0.2)).toEqual({
      positionFromOffset: 0,
      positionFromVelocity: 0,
      velocityFromOffset: 0,
      velocityFromVelocity: 0,
    });

    const beforeEnd = cubicDecayCoefficients(0.199, 0.2);
    expect(Math.abs(beforeEnd.positionFromOffset)).toBeLessThan(0.001);
    expect(Math.abs(beforeEnd.velocityFromVelocity)).toBeLessThan(0.02);
  });

  it('rejects single-frame contact flicker with a five-frame vote', () => {
    expect(hasContactMajority([false, false, true, false, false])).toBe(false);
    expect(hasContactMajority([true, false, true, false, true])).toBe(true);
  });

  it('annotates contact from the source pose rather than the terrain height', () => {
    expect(isSourceFootContact(0.08, 0.01, 0.52, 0.12)).toBe(true);
    expect(isSourceFootContact(0.08, 0.22, 0.52, 0.12)).toBe(false);
    expect(isSourceFootContact(0.8, 0.01, 0.52, 0.12)).toBe(false);
  });

  it('keeps a planted sole on its prior tread while it retains meaningful coverage', () => {
    const selection = selectFootSupport(
      [
        { colliderHandle: 10, height: 0.52, normalY: 1, isAnchor: false },
        { colliderHandle: 10, height: 0.52, normalY: 1, isAnchor: false },
        { colliderHandle: 20, height: 0, normalY: 1, isAnchor: true },
        { colliderHandle: 20, height: 0, normalY: 1, isAnchor: false },
        { colliderHandle: 20, height: 0, normalY: 1, isAnchor: false },
      ],
      10,
      0.08,
      0.6,
    );

    expect(selection.colliderHandle).toBe(10);
    expect(selection.supportCount).toBe(2);
    expect(selection.isLedge).toBe(true);
    expect(selection.heightRange).toBeCloseTo(0.52);
  });

  it('releases a planted tread when only one edge probe remains', () => {
    const selection = selectFootSupport(
      [
        { colliderHandle: 10, height: 0.52, normalY: 1, isAnchor: false },
        { colliderHandle: 20, height: 0, normalY: 1, isAnchor: true },
        { colliderHandle: 20, height: 0, normalY: 1, isAnchor: false },
        { colliderHandle: 20, height: 0, normalY: 1, isAnchor: false },
        { colliderHandle: 20, height: 0, normalY: 1, isAnchor: false },
      ],
      10,
      0.08,
      0.6,
    );

    expect(selection.colliderHandle).toBe(20);
    expect(selection.supportCount).toBe(4);
    expect(selection.isLedge).toBe(true);
  });

  it('uses sole coverage after release and ignores vertical faces', () => {
    const selection = selectFootSupport(
      [
        { colliderHandle: 10, height: 0.52, normalY: 1, isAnchor: false },
        { colliderHandle: 20, height: 0, normalY: 1, isAnchor: true },
        { colliderHandle: 20, height: 0, normalY: 1, isAnchor: false },
        { colliderHandle: 20, height: 0.25, normalY: 0.1, isAnchor: false },
      ],
      null,
      0.08,
      0.6,
    );

    expect(selection.colliderHandle).toBe(20);
    expect(selection.supportCount).toBe(2);
    expect(selection.sampleCount).toBe(3);
    expect(selection.isLedge).toBe(true);
  });

  it('does not classify coplanar adjacent colliders as a ledge', () => {
    const selection = selectFootSupport(
      [
        { colliderHandle: 10, height: 0.2, normalY: 1, isAnchor: true },
        { colliderHandle: 10, height: 0.205, normalY: 1, isAnchor: false },
        { colliderHandle: 20, height: 0.2, normalY: 1, isAnchor: false },
      ],
      null,
      0.08,
      0.6,
    );

    expect(selection.isLedge).toBe(false);
  });

  it('drops the pelvis enough to keep split-height contacts within preferred reach', () => {
    const offset = solvePelvisReachOffset(
      [
        { hipY: 1.52, targetY: 0.086, horizontalDistance: 0.18, preferredLength: 0.85, maximumLength: 0.89 },
        { hipY: 1.52, targetY: 0.606, horizontalDistance: 0.18, preferredLength: 0.85, maximumLength: 0.89 },
      ],
      0.58,
      0.1,
    );
    expect(offset).toBeLessThan(-0.5);
    expect(offset).toBeGreaterThanOrEqual(-0.58);
  });

  it('keeps a level reachable stance unchanged and bounds impossible corrections', () => {
    expect(
      solvePelvisReachOffset(
        [
          { hipY: 0.9, targetY: 0.1, horizontalDistance: 0.1, preferredLength: 0.9, maximumLength: 0.95 },
          { hipY: 0.9, targetY: 0.1, horizontalDistance: 0.1, preferredLength: 0.9, maximumLength: 0.95 },
        ],
        0.58,
        0.1,
      ),
    ).toBe(0);

    const impossible = solvePelvisReachOffset(
      [
        { hipY: 1, targetY: 0, horizontalDistance: 0.1, preferredLength: 0.8, maximumLength: 0.9 },
        { hipY: 1, targetY: 2.5, horizontalDistance: 0.1, preferredLength: 0.8, maximumLength: 0.9 },
      ],
      0.58,
      0.1,
    );
    expect(impossible).toBe(0.1);
  });
});
