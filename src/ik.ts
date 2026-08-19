import { MathUtils, Vector3 } from 'three';

export type LimbReachability = 'reachable' | 'tooClose' | 'tooFar';

export interface LimbReachResult {
  status: LimbReachability;
  requestedDistance: number;
  solvedDistance: number;
  minimumDistance: number;
  maximumDistance: number;
  extensionRatio: number;
  unmetDistance: number;
}

export interface FootbaseResult {
  balance: number;
  pivot: Vector3;
}

export interface CubicDecayCoefficients {
  positionFromOffset: number;
  positionFromVelocity: number;
  velocityFromOffset: number;
  velocityFromVelocity: number;
}

export interface LegReachConstraint {
  hipY: number;
  targetY: number;
  horizontalDistance: number;
  preferredLength: number;
  maximumLength: number;
  priority?: number;
}

/**
 * Classifies both degeneracies of an analytic two-bone chain and computes a
 * singularity-safe distance. The status always describes the original target,
 * even when the returned distance has been softened or clamped.
 */
export function solveLimbReach(
  requestedDistance: number,
  upperLength: number,
  lowerLength: number,
  maximumExtension: number,
  softness: number,
): LimbReachResult {
  const upper = Math.max(0, upperLength);
  const lower = Math.max(0, lowerLength);
  const geometricMaximum = Math.max(0.001, upper + lower - 0.003);
  const minimumDistance = Math.min(
    geometricMaximum,
    Math.abs(upper - lower) + 0.001,
  );
  const maximumDistance = MathUtils.clamp(
    maximumExtension,
    minimumDistance,
    geometricMaximum,
  );
  const requested = Math.max(0, requestedDistance);
  const status: LimbReachability =
    requested < minimumDistance
      ? 'tooClose'
      : requested > maximumDistance
        ? 'tooFar'
        : 'reachable';
  const softened = softClampExtension(requested, maximumDistance, softness);
  const solvedDistance = MathUtils.clamp(softened, minimumDistance, geometricMaximum);

  return {
    status,
    requestedDistance: requested,
    solvedDistance,
    minimumDistance,
    maximumDistance,
    extensionRatio: maximumDistance > 0 ? solvedDistance / maximumDistance : 0,
    unmetDistance: Math.abs(requested - solvedDistance),
  };
}

/** Johansen-style heel/toe balance used to choose the stance footbase pivot. */
export function footbaseBalance(
  heelHeight: number,
  toeHeight: number,
  footLength: number,
  alpha = 20,
): number {
  const denominator = Math.max(0.0001, Math.abs(footLength) * Math.max(0.0001, alpha));
  return MathUtils.clamp(Math.atan((heelHeight - toeHeight) / denominator) / Math.PI + 0.5, 0, 1);
}

/** A balance of zero pivots at the heel; one pivots at the toe. */
export function solveFootbase(
  heelPosition: Vector3,
  toePosition: Vector3,
  heelHeight: number,
  toeHeight: number,
  footLength: number,
  alpha = 20,
  target = new Vector3(),
): FootbaseResult {
  const balance = footbaseBalance(heelHeight, toeHeight, footLength, alpha);
  return {
    balance,
    pivot: target.copy(heelPosition).lerp(toePosition, balance),
  };
}

export interface FootSupportSample {
  colliderHandle: number;
  height: number;
  normalY: number;
  isAnchor: boolean;
}

export interface FootSupportSelection {
  colliderHandle: number | null;
  supportCount: number;
  sampleCount: number;
  isLedge: boolean;
  heightRange: number;
}

interface ReachInterval {
  minimum: number;
  maximum: number;
}

/**
 * Leaves normal reach untouched, then approaches maximum extension
 * asymptotically. This keeps a two-bone chain away from its singular,
 * completely straight configuration without introducing a hard snap.
 */
export function softClampExtension(requested: number, maximum: number, softness: number): number {
  const safeMaximum = Math.max(0, maximum);
  if (softness <= 0) return Math.min(requested, safeMaximum);
  const softStart = Math.max(0, safeMaximum - softness);
  if (requested <= softStart) return requested;
  return safeMaximum - softness * Math.exp(-(requested - softStart) / softness);
}

/** Cubic Hermite decay from an offset/velocity pair to zero/zero. */
export function cubicDecayCoefficients(elapsed: number, duration: number): CubicDecayCoefficients {
  if (duration <= 0 || elapsed >= duration) {
    return {
      positionFromOffset: 0,
      positionFromVelocity: 0,
      velocityFromOffset: 0,
      velocityFromVelocity: 0,
    };
  }

  const u = MathUtils.clamp(elapsed / duration, 0, 1);
  const u2 = u * u;
  const u3 = u2 * u;
  return {
    positionFromOffset: 2 * u3 - 3 * u2 + 1,
    positionFromVelocity: duration * (u3 - 2 * u2 + u),
    velocityFromOffset: (6 * u2 - 6 * u) / duration,
    velocityFromVelocity: 3 * u2 - 4 * u + 1,
  };
}

export function hasContactMajority(samples: readonly boolean[]): boolean {
  if (samples.length === 0) return false;
  let contacts = 0;
  for (const sample of samples) contacts += sample ? 1 : 0;
  return contacts >= Math.floor(samples.length / 2) + 1;
}

/** Contact annotation belongs to the authored pose, not the terrain below it. */
export function isSourceFootContact(
  toeSpeed: number,
  toeHeightAboveRest: number,
  maximumSpeed: number,
  maximumHeight: number,
): boolean {
  return toeSpeed <= maximumSpeed && toeHeightAboveRest >= -0.04 && toeHeightAboveRest <= maximumHeight;
}

/**
 * Selects one continuous surface for the whole sole. A planted surface keeps
 * ownership while any sole probe still sees it; otherwise the surface with
 * the most coverage wins. This prevents a toe ray from snapping through a
 * riser before the rest of the foot has crossed the ledge.
 */
export function selectFootSupport(
  samples: readonly FootSupportSample[],
  lockedColliderHandle: number | null,
  maximumHeightDiscontinuity: number,
  minimumNormalY: number,
  minimumPersistentSamples = 2,
): FootSupportSelection {
  const validSamples = samples.filter((sample) => sample.normalY >= minimumNormalY);
  const groups = new Map<
    number,
    { colliderHandle: number; count: number; anchorCount: number; heightTotal: number }
  >();

  for (const sample of validSamples) {
    const group = groups.get(sample.colliderHandle) ?? {
      colliderHandle: sample.colliderHandle,
      count: 0,
      anchorCount: 0,
      heightTotal: 0,
    };
    group.count += 1;
    group.anchorCount += sample.isAnchor ? 1 : 0;
    group.heightTotal += sample.height;
    groups.set(sample.colliderHandle, group);
  }

  if (groups.size === 0) {
    return {
      colliderHandle: null,
      supportCount: 0,
      sampleCount: 0,
      isLedge: false,
      heightRange: 0,
    };
  }

  const ranked = [...groups.values()].sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    if (a.anchorCount !== b.anchorCount) return b.anchorCount - a.anchorCount;
    return b.heightTotal / b.count - a.heightTotal / a.count;
  });
  const groupHeights = ranked.map((group) => group.heightTotal / group.count);
  const minimumHeight = Math.min(...groupHeights);
  const maximumHeight = Math.max(...groupHeights);
  const heightRange = maximumHeight - minimumHeight;
  const isLedge = groups.size > 1 && heightRange > maximumHeightDiscontinuity;
  const lockedCandidate = lockedColliderHandle === null ? undefined : groups.get(lockedColliderHandle);
  const locked =
    lockedCandidate && lockedCandidate.count >= minimumPersistentSamples
      ? lockedCandidate
      : undefined;
  const highestStable = isLedge
    ? [...groups.values()]
        .filter((group) => group.count >= minimumPersistentSamples)
        .sort((a, b) => b.heightTotal / b.count - a.heightTotal / a.count)[0]
    : undefined;
  const selected = locked ?? highestStable ?? ranked[0];

  return {
    colliderHandle: selected.colliderHandle,
    supportCount: selected.count,
    sampleCount: validSamples.length,
    isLedge,
    heightRange,
  };
}

function reachInterval(constraint: LegReachConstraint, useMaximumLength: boolean): ReachInterval {
  const length = Math.max(0, useMaximumLength ? constraint.maximumLength : constraint.preferredLength);
  const horizontal = Math.max(0, constraint.horizontalDistance);
  const verticalReach = Math.sqrt(Math.max(0, length * length - horizontal * horizontal));
  return {
    minimum: constraint.targetY - verticalReach - constraint.hipY,
    maximum: constraint.targetY + verticalReach - constraint.hipY,
  };
}

function solveIntervals(
  constraints: readonly LegReachConstraint[],
  useMaximumLength: boolean,
): { offset: number; intersects: boolean } {
  let minimum = Number.NEGATIVE_INFINITY;
  let maximum = Number.POSITIVE_INFINITY;
  for (const constraint of constraints) {
    const interval = reachInterval(constraint, useMaximumLength);
    minimum = Math.max(minimum, interval.minimum);
    maximum = Math.min(maximum, interval.maximum);
  }

  if (minimum <= maximum) {
    return { offset: MathUtils.clamp(0, minimum, maximum), intersects: true };
  }

  // When both contacts cannot be satisfied, bias the compromise toward the
  // higher-confidence foot instead of distorting both legs equally.
  const lowerOwner = constraints
    .map((constraint) => ({ constraint, interval: reachInterval(constraint, useMaximumLength) }))
    .reduce((best, candidate) => candidate.interval.minimum > best.interval.minimum ? candidate : best);
  const upperOwner = constraints
    .map((constraint) => ({ constraint, interval: reachInterval(constraint, useMaximumLength) }))
    .reduce((best, candidate) => candidate.interval.maximum < best.interval.maximum ? candidate : best);
  const lowerWeight = Math.max(0.001, lowerOwner.constraint.priority ?? 1);
  const upperWeight = Math.max(0.001, upperOwner.constraint.priority ?? 1);
  return {
    offset: (minimum * lowerWeight + maximum * upperWeight) / (lowerWeight + upperWeight),
    intersects: false,
  };
}

/** Finds the smallest vertical pelvis correction that makes every active leg reachable. */
export function solvePelvisReachOffset(
  constraints: readonly LegReachConstraint[],
  maximumDrop: number,
  maximumRise: number,
): number {
  if (constraints.length === 0) return 0;
  const preferred = solveIntervals(constraints, false);
  const solution = preferred.intersects ? preferred : solveIntervals(constraints, true);
  return MathUtils.clamp(solution.offset, -Math.max(0, maximumDrop), Math.max(0, maximumRise));
}
