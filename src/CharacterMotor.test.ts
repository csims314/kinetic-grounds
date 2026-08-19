import RAPIER from '@dimforge/rapier3d-compat';
import { Vector2, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { CharacterMotor } from './CharacterMotor';
import type { InputFrame } from './InputController';

function frame(forward = 0, jumpPressed = false, horizontal = 0): InputFrame {
  return {
    move: new Vector2(horizontal, forward),
    walk: false,
    sprint: false,
    jumpPressed,
    resetPressed: false,
    debugPressed: false,
  };
}

describe('CharacterMotor', () => {
  it('settles on the ground, accelerates camera-forward, and jumps', async () => {
    await RAPIER.init();
    const world = new RAPIER.World({ x: 0, y: -18, z: 0 });
    const floorBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
    world.createCollider(RAPIER.ColliderDesc.cuboid(20, 0.5, 20), floorBody);
    const motor = new CharacterMotor(world, new Vector3(0, 1.05, 0));

    let snapshot = motor.snapshot();
    for (let i = 0; i < 90; i += 1) snapshot = motor.simulate(1 / 60, frame(), 0);
    expect(snapshot.grounded).toBe(true);
    expect(snapshot.position.y).toBeGreaterThan(0.85);
    expect(snapshot.position.y).toBeLessThan(1.2);

    for (let i = 0; i < 60; i += 1) snapshot = motor.simulate(1 / 60, frame(1), 0);
    expect(snapshot.position.z).toBeGreaterThan(3);
    expect(snapshot.speed).toBeGreaterThan(4);

    snapshot = motor.simulate(1 / 60, frame(1, true), 0);
    expect(snapshot.grounded).toBe(false);
    expect(snapshot.velocity.y).toBeGreaterThan(5);
    expect(snapshot.state).toBe('jumpStart');
  });

  it('maps D to camera-right instead of world-right at yaw zero', async () => {
    await RAPIER.init();
    const world = new RAPIER.World({ x: 0, y: -18, z: 0 });
    const floorBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
    world.createCollider(RAPIER.ColliderDesc.cuboid(20, 0.5, 20), floorBody);
    const motor = new CharacterMotor(world, new Vector3(0, 1.05, 0));

    for (let i = 0; i < 90; i += 1) motor.simulate(1 / 60, frame(), 0);
    let snapshot = motor.snapshot();
    for (let i = 0; i < 60; i += 1) snapshot = motor.simulate(1 / 60, frame(0, false, 1), 0);

    expect(snapshot.position.x).toBeLessThan(-3);
    expect(Math.abs(snapshot.position.z)).toBeLessThan(0.1);
  });

  it('inherits support displacement from a moving platform', async () => {
    await RAPIER.init();
    const world = new RAPIER.World({ x: 0, y: -18, z: 0 });
    const floorBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
    world.createCollider(RAPIER.ColliderDesc.cuboid(20, 0.5, 20), floorBody);
    const motor = new CharacterMotor(world, new Vector3(0, 1.05, 0));
    for (let i = 0; i < 90; i += 1) motor.simulate(1 / 60, frame(), 0);

    const before = motor.snapshot().position.x;
    const after = motor.simulate(1 / 60, frame(), 0, new Vector3(0.08, 0, 0));
    expect(after.position.x - before).toBeCloseTo(0.08, 3);
  });
});
