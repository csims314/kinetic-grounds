import { MathUtils, Vector2, Vector3 } from 'three';

export function damp(current: number, target: number, sharpness: number, dt: number): number {
  return MathUtils.lerp(current, target, 1 - Math.exp(-sharpness * dt));
}

export function dampVector3(
  current: Vector3,
  target: Vector3,
  sharpness: number,
  dt: number,
): Vector3 {
  return current.lerp(target, 1 - Math.exp(-sharpness * dt));
}

export function moveTowardVector2(
  current: Vector2,
  target: Vector2,
  maxDelta: number,
): Vector2 {
  const delta = target.clone().sub(current);
  const distance = delta.length();
  if (distance <= maxDelta || distance === 0) return current.copy(target);
  return current.addScaledVector(delta, maxDelta / distance);
}

export function shortestAngleDelta(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

export function dampAngle(current: number, target: number, sharpness: number, dt: number): number {
  return current + shortestAngleDelta(current, target) * (1 - Math.exp(-sharpness * dt));
}

export function clamp01(value: number): number {
  return MathUtils.clamp(value, 0, 1);
}

export function smoothstep01(value: number): number {
  const x = clamp01(value);
  return x * x * (3 - 2 * x);
}

export function formatState(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase();
}
