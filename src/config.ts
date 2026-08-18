export const CONFIG = {
  simulationHz: 60,
  spawn: { x: 0, y: 1.05, z: -16 },
  motor: {
    capsuleRadius: 0.32,
    capsuleHalfHeight: 0.57,
    skinWidth: 0.025,
    walkSpeed: 2,
    jogSpeed: 4.5,
    sprintSpeed: 7.5,
    groundAcceleration: 28,
    groundBraking: 34,
    airAcceleration: 8,
    gravity: 18,
    jumpVelocity: 6.25,
    coyoteTime: 0.12,
    jumpBuffer: 0.14,
    autostepHeight: 0.35,
    autostepMinWidth: 0.24,
    groundSnap: 0.3,
    maxSlope: (48 * Math.PI) / 180,
    minSlideSlope: (52 * Math.PI) / 180,
    turnSharpness: 14,
    hardLandSpeed: 7.5,
  },
  camera: {
    fov: 56,
    targetHeight: 1.35,
    distance: 4.8,
    minDistance: 2.7,
    maxDistance: 7.2,
    pitch: 0.28,
    minPitch: -0.12,
    maxPitch: 1.05,
    mouseSensitivity: 0.0022,
    positionSharpness: 16,
    targetSharpness: 18,
    collisionRadius: 0.18,
  },
  ik: {
    footProbeUp: 0.42,
    footProbeLength: 1.15,
    ankleHeight: 0.105,
    maxPelvisDrop: 0.25,
    maxPelvisRise: 0.08,
    pelvisSharpness: 15,
    footSharpness: 22,
    footReleaseDistance: 0.42,
    handReach: 0.72,
    handSharpness: 12,
  },
  quality: {
    maxPixelRatio: 1.5,
    shadowMapSize: 2048,
  },
} as const;

export type LocomotionState =
  | 'idle'
  | 'walk'
  | 'jog'
  | 'sprint'
  | 'jumpStart'
  | 'airborne'
  | 'land'
  | 'hardLand';

export const PALETTE = {
  sky: 0x96a6ac,
  fog: 0x96a6ac,
  ink: 0x10151c,
  concrete: 0xc4c2b9,
  concreteDark: 0x6c7375,
  platform: 0xd8d4c8,
  accent: 0xff5533,
  acid: 0xd7ff45,
  blue: 0x2d7894,
  shadow: 0x323b3c,
} as const;
