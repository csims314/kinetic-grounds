import RAPIER from '@dimforge/rapier3d-compat';
import { MathUtils, PerspectiveCamera, Vector2, Vector3 } from 'three';
import { CONFIG } from './config';
import type { MotorSnapshot } from './CharacterMotor';
import { damp, dampVector3 } from './math';

export class ThirdPersonCamera {
  yaw = 0;
  pitch: number = CONFIG.camera.pitch;
  private distance: number = CONFIG.camera.distance;
  private desiredDistance: number = CONFIG.camera.distance;
  private readonly target = new Vector3();
  private readonly desiredTarget = new Vector3();
  private readonly desiredPosition = new Vector3();
  private readonly displacement = new Vector3();
  private readonly collisionShape = new RAPIER.Ball(CONFIG.camera.collisionRadius);

  constructor(readonly camera: PerspectiveCamera) {}

  applyInput(look: Vector2, wheel: number): void {
    const c = CONFIG.camera;
    this.yaw += look.x * c.mouseSensitivity;
    this.pitch = MathUtils.clamp(
      this.pitch + look.y * c.mouseSensitivity,
      c.minPitch,
      c.maxPitch,
    );
    this.desiredDistance = MathUtils.clamp(
      this.desiredDistance + wheel * 0.0025,
      c.minDistance,
      c.maxDistance,
    );
  }

  update(
    dt: number,
    motor: MotorSnapshot,
    world: RAPIER.World,
    playerCollider: RAPIER.Collider,
    immediate = false,
  ): void {
    const c = CONFIG.camera;
    const feetY = motor.position.y - (CONFIG.motor.capsuleHalfHeight + CONFIG.motor.capsuleRadius);
    this.desiredTarget.set(
      motor.position.x + motor.velocity.x * 0.035,
      feetY + c.targetHeight,
      motor.position.z + motor.velocity.z * 0.035,
    );
    if (immediate) this.target.copy(this.desiredTarget);
    else dampVector3(this.target, this.desiredTarget, c.targetSharpness, dt);

    this.distance = damp(this.distance, this.desiredDistance, 10, dt);
    const planarDistance = Math.cos(this.pitch) * this.distance;
    this.desiredPosition.set(
      this.target.x - Math.sin(this.yaw) * planarDistance,
      this.target.y + Math.sin(this.pitch) * this.distance,
      this.target.z - Math.cos(this.yaw) * planarDistance,
    );

    this.displacement.copy(this.desiredPosition).sub(this.target);
    const hit = world.castShape(
      this.target,
      { x: 0, y: 0, z: 0, w: 1 },
      this.displacement,
      this.collisionShape,
      0.025,
      1,
      true,
      undefined,
      undefined,
      playerCollider,
    );
    if (hit) {
      const safeToi = Math.max(0, hit.time_of_impact - 0.025);
      this.desiredPosition.copy(this.target).addScaledVector(this.displacement, safeToi);
    }

    if (immediate) this.camera.position.copy(this.desiredPosition);
    else dampVector3(this.camera.position, this.desiredPosition, c.positionSharpness, dt);
    this.camera.lookAt(this.target);
  }

  reset(motor: MotorSnapshot, world: RAPIER.World, playerCollider: RAPIER.Collider): void {
    this.yaw = motor.heading;
    this.pitch = CONFIG.camera.pitch;
    this.distance = CONFIG.camera.distance;
    this.desiredDistance = CONFIG.camera.distance;
    this.update(1 / 60, motor, world, playerCollider, true);
  }
}
