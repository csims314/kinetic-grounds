import RAPIER from '@dimforge/rapier3d-compat';
import { MathUtils, Vector2, Vector3 } from 'three';
import { CONFIG, type LocomotionState } from './config';
import type { InputFrame } from './InputController';
import { dampAngle, moveTowardVector2 } from './math';

export interface MotorSnapshot {
  position: Vector3;
  velocity: Vector3;
  heading: number;
  speed: number;
  grounded: boolean;
  state: LocomotionState;
  landingImpact: number;
  airtime: number;
}

export class CharacterMotor {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  readonly controller: RAPIER.KinematicCharacterController;
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  heading = 0;
  grounded = false;

  private readonly planarVelocity = new Vector2();
  private verticalVelocity = 0;
  private coyoteRemaining = 0;
  private jumpBuffered = 0;
  private landingTimer = 0;
  private landingImpact = 0;
  private airtime = 0;
  private state: LocomotionState = 'idle';

  constructor(
    private readonly world: RAPIER.World,
    spawn: Vector3,
  ) {
    const c = CONFIG.motor;
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(spawn.x, spawn.y, spawn.z)
        .setCanSleep(false),
    );
    this.collider = world.createCollider(
      RAPIER.ColliderDesc.capsule(c.capsuleHalfHeight, c.capsuleRadius)
        .setFriction(0)
        .setRestitution(0),
      this.body,
    );
    this.controller = world.createCharacterController(c.skinWidth);
    this.controller.setUp({ x: 0, y: 1, z: 0 });
    this.controller.enableAutostep(c.autostepHeight, c.autostepMinWidth, false);
    this.controller.enableSnapToGround(c.groundSnap);
    this.controller.setMaxSlopeClimbAngle(c.maxSlope);
    this.controller.setMinSlopeSlideAngle(c.minSlideSlope);
    this.position.copy(spawn);
  }

  simulate(
    dt: number,
    input: InputFrame,
    cameraYaw: number,
    supportDisplacement?: Vector3,
  ): MotorSnapshot {
    const c = CONFIG.motor;
    if (input.jumpPressed) this.jumpBuffered = c.jumpBuffer;
    else this.jumpBuffered = Math.max(0, this.jumpBuffered - dt);

    if (this.grounded) this.coyoteRemaining = c.coyoteTime;
    else this.coyoteRemaining = Math.max(0, this.coyoteRemaining - dt);

    const forward = new Vector2(Math.sin(cameraYaw), Math.cos(cameraYaw));
    // Three.js cameras look down local -Z. With our yaw-zero camera placed behind
    // the player and looking toward world +Z, screen-right is world -X.
    const right = new Vector2(-Math.cos(cameraYaw), Math.sin(cameraYaw));
    const desiredDirection = right.multiplyScalar(input.move.x).add(forward.multiplyScalar(input.move.y));
    if (desiredDirection.lengthSq() > 1) desiredDirection.normalize();

    let targetSpeed: number = c.jogSpeed;
    if (input.walk) targetSpeed = c.walkSpeed;
    else if (input.sprint && input.move.y > -0.15) targetSpeed = c.sprintSpeed;
    const targetVelocity = desiredDirection.multiplyScalar(targetSpeed);
    const hasInput = targetVelocity.lengthSq() > 0.0001;
    const acceleration = this.grounded
      ? hasInput
        ? c.groundAcceleration
        : c.groundBraking
      : c.airAcceleration;
    moveTowardVector2(this.planarVelocity, targetVelocity, acceleration * dt);

    if (hasInput) {
      const targetHeading = Math.atan2(targetVelocity.x, targetVelocity.y);
      this.heading = dampAngle(this.heading, targetHeading, c.turnSharpness, dt);
    }

    if (this.jumpBuffered > 0 && this.coyoteRemaining > 0) {
      this.verticalVelocity = c.jumpVelocity;
      this.grounded = false;
      this.coyoteRemaining = 0;
      this.jumpBuffered = 0;
      this.airtime = 0;
    } else {
      this.verticalVelocity -= c.gravity * dt;
    }

    const current = this.body.translation();
    const desired = {
      x: this.planarVelocity.x * dt + (supportDisplacement?.x ?? 0),
      y: this.verticalVelocity * dt + (supportDisplacement?.y ?? 0),
      z: this.planarVelocity.y * dt + (supportDisplacement?.z ?? 0),
    };
    this.controller.computeColliderMovement(this.collider, desired);
    const corrected = this.controller.computedMovement();
    const wasGrounded = this.grounded;
    const impactVelocity = this.verticalVelocity;
    this.grounded = this.controller.computedGrounded();

    if (desired.y > 0 && corrected.y + 0.001 < desired.y) this.verticalVelocity = 0;
    if (this.grounded && this.verticalVelocity < 0) this.verticalVelocity = -0.5;

    this.body.setNextKinematicTranslation({
      x: current.x + corrected.x,
      y: current.y + corrected.y,
      z: current.z + corrected.z,
    });
    this.world.timestep = dt;
    this.world.step();

    const next = this.body.translation();
    this.position.set(next.x, next.y, next.z);
    this.velocity.set(this.planarVelocity.x, this.verticalVelocity, this.planarVelocity.y);

    if (!this.grounded) this.airtime += dt;
    if (!wasGrounded && this.grounded) {
      this.landingImpact = Math.abs(Math.min(impactVelocity, 0));
      this.landingTimer = this.landingImpact > c.hardLandSpeed ? 0.38 : 0.24;
      this.airtime = 0;
    } else {
      this.landingTimer = Math.max(0, this.landingTimer - dt);
    }

    this.state = this.resolveState();
    return this.snapshot();
  }

  reset(spawn: Vector3): void {
    this.body.setTranslation({ x: spawn.x, y: spawn.y, z: spawn.z }, true);
    this.body.setNextKinematicTranslation({ x: spawn.x, y: spawn.y, z: spawn.z });
    this.position.copy(spawn);
    this.planarVelocity.set(0, 0);
    this.velocity.set(0, 0, 0);
    this.verticalVelocity = 0;
    this.grounded = false;
    this.heading = 0;
    this.airtime = 0;
    this.landingTimer = 0;
  }

  snapshot(): MotorSnapshot {
    return {
      position: this.position.clone(),
      velocity: this.velocity.clone(),
      heading: this.heading,
      speed: this.planarVelocity.length(),
      grounded: this.grounded,
      state: this.state,
      landingImpact: this.landingImpact,
      airtime: this.airtime,
    };
  }

  private resolveState(): LocomotionState {
    if (!this.grounded) return this.verticalVelocity > 0.5 && this.airtime < 0.3 ? 'jumpStart' : 'airborne';
    if (this.landingTimer > 0) {
      return this.landingImpact > CONFIG.motor.hardLandSpeed ? 'hardLand' : 'land';
    }
    const speed = this.planarVelocity.length();
    if (speed < 0.15) return 'idle';
    if (speed < MathUtils.lerp(CONFIG.motor.walkSpeed, CONFIG.motor.jogSpeed, 0.45)) return 'walk';
    if (speed < MathUtils.lerp(CONFIG.motor.jogSpeed, CONFIG.motor.sprintSpeed, 0.55)) return 'jog';
    return 'sprint';
  }
}
