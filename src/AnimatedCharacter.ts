import RAPIER from '@dimforge/rapier3d-compat';
import {
  AnimationAction,
  AnimationClip,
  AnimationMixer,
  Bone,
  Group,
  LoopOnce,
  LoopRepeat,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Quaternion,
  Scene,
  SphereGeometry,
  Vector3,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { CONFIG, PALETTE, type LocomotionState } from './config';
import type { MotorSnapshot } from './CharacterMotor';
import { Course } from './Course';
import { damp } from './math';

interface Rig {
  pelvis: Bone;
  thighL: Bone;
  calfL: Bone;
  footL: Bone;
  thighR: Bone;
  calfR: Bone;
  footR: Bone;
  upperArmL: Bone;
  lowerArmL: Bone;
  handL: Bone;
  upperArmR: Bone;
  lowerArmR: Bone;
  handR: Bone;
}

interface Limb {
  root: Bone;
  middle: Bone;
  end: Bone;
}

interface FootRuntime {
  side: -1 | 1;
  limb: Limb;
  target: Vector3;
  normal: Vector3;
  previousAnimatedPosition: Vector3;
  lockedTarget: Vector3;
  locked: boolean;
  weight: number;
  localUpAxis: Vector3;
  marker: Mesh;
  hasGround: boolean;
}

interface HandRuntime {
  side: -1 | 1;
  limb: Limb;
  target: Vector3;
  normal: Vector3;
  weight: number;
  localPalmAxis: Vector3;
  marker: Mesh;
  contacting: boolean;
  probeOrigin: Vector3;
}

const CLIP_FOR_STATE: Record<LocomotionState, string> = {
  idle: 'Idle_Loop',
  walk: 'Walk_Loop',
  jog: 'Jog_Fwd_Loop',
  sprint: 'Sprint_Loop',
  jumpStart: 'Jump_Start',
  airborne: 'Jump_Loop',
  land: 'Jump_Land',
  hardLand: 'Jump_Land',
};

const LOOPING_STATES = new Set<LocomotionState>(['idle', 'walk', 'jog', 'sprint', 'airborne']);
const _start = new Vector3();
const _middle = new Vector3();
const _end = new Vector3();
const _direction = new Vector3();
const _poleDirection = new Vector3();
const _desiredMiddle = new Vector3();
const _currentDirection = new Vector3();
const _desiredDirection = new Vector3();
const _currentWorldQuaternion = new Quaternion();
const _parentWorldQuaternion = new Quaternion();
const _deltaQuaternion = new Quaternion();
const _desiredWorldQuaternion = new Quaternion();
const _desiredLocalQuaternion = new Quaternion();
const _inverseQuaternion = new Quaternion();

function requireBone(root: Object3D, name: string): Bone {
  const object = root.getObjectByName(name);
  if (!(object instanceof Bone)) throw new Error(`The character rig is missing required bone “${name}”.`);
  return object;
}

function configureShadows(root: Object3D): void {
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    object.castShadow = true;
    object.receiveShadow = true;
    object.frustumCulled = false;
  });
}

function animationSpeed(state: LocomotionState, speed: number): number {
  if (state === 'walk') return MathUtils.clamp(speed / 1.8, 0.78, 1.25);
  if (state === 'jog') return MathUtils.clamp(speed / 4.1, 0.82, 1.25);
  if (state === 'sprint') return MathUtils.clamp(speed / 7.1, 0.88, 1.18);
  return 1;
}

export class AnimatedCharacter {
  readonly root: Group;
  readonly debugGroup = new Group();
  readonly mixer: AnimationMixer;

  private readonly rig: Rig;
  private readonly actions = new Map<string, AnimationAction>();
  private readonly feet: FootRuntime[];
  private readonly hands: HandRuntime[];
  private activeAction: AnimationAction | null = null;
  private activeState: LocomotionState | null = null;
  private pelvisOffset = 0;
  private debugVisible = false;

  private constructor(
    scene: Scene,
    model: GLTF,
    animations: GLTF,
    private readonly world: RAPIER.World,
    private readonly playerCollider: RAPIER.Collider,
    private readonly course: Course,
  ) {
    this.root = model.scene;
    this.root.name = 'Night Striker — Quaternius CC0';
    configureShadows(this.root);
    scene.add(this.root);

    this.rig = {
      pelvis: requireBone(this.root, 'pelvis'),
      thighL: requireBone(this.root, 'thigh_l'),
      calfL: requireBone(this.root, 'calf_l'),
      footL: requireBone(this.root, 'foot_l'),
      thighR: requireBone(this.root, 'thigh_r'),
      calfR: requireBone(this.root, 'calf_r'),
      footR: requireBone(this.root, 'foot_r'),
      upperArmL: requireBone(this.root, 'upperarm_l'),
      lowerArmL: requireBone(this.root, 'lowerarm_l'),
      handL: requireBone(this.root, 'hand_l'),
      upperArmR: requireBone(this.root, 'upperarm_r'),
      lowerArmR: requireBone(this.root, 'lowerarm_r'),
      handR: requireBone(this.root, 'hand_r'),
    };

    this.mixer = new AnimationMixer(this.root);
    for (const clipName of new Set(Object.values(CLIP_FOR_STATE))) {
      const clip = AnimationClip.findByName(animations.animations, clipName);
      if (!clip) throw new Error(`The animation library is missing required clip “${clipName}”.`);
      const action = this.mixer.clipAction(clip);
      this.actions.set(clipName, action);
    }

    const markerGeometry = new SphereGeometry(0.055, 8, 6);
    const footMaterial = new MeshBasicMaterial({ color: PALETTE.acid, depthTest: false });
    const handMaterial = new MeshBasicMaterial({ color: PALETTE.accent, depthTest: false });
    this.root.updateMatrixWorld(true);

    this.feet = [
      this.createFootRuntime(-1, this.rig.thighL, this.rig.calfL, this.rig.footL, markerGeometry, footMaterial),
      this.createFootRuntime(1, this.rig.thighR, this.rig.calfR, this.rig.footR, markerGeometry, footMaterial),
    ];
    this.hands = [
      this.createHandRuntime(
        -1,
        this.rig.upperArmL,
        this.rig.lowerArmL,
        this.rig.handL,
        markerGeometry,
        handMaterial,
      ),
      this.createHandRuntime(
        1,
        this.rig.upperArmR,
        this.rig.lowerArmR,
        this.rig.handR,
        markerGeometry,
        handMaterial,
      ),
    ];
    this.debugGroup.name = 'IK targets';
    this.debugGroup.visible = false;
    scene.add(this.debugGroup);
    this.playState('idle', 0, true);
  }

  static async load(
    scene: Scene,
    world: RAPIER.World,
    playerCollider: RAPIER.Collider,
    course: Course,
    onProgress: (label: string, amount: number) => void,
  ): Promise<AnimatedCharacter> {
    const loader = new GLTFLoader();
    onProgress('LOADING AUTHORED CHARACTER', 0.18);
    const model = await loader.loadAsync('/assets/quaternius/night-striker.glb');
    onProgress('LOADING 43 MOTION CLIPS', 0.62);
    const animations = await loader.loadAsync('/assets/quaternius/universal-animation-library.glb');
    onProgress('CALIBRATING HUMANOID RIG', 0.84);
    return new AnimatedCharacter(scene, model, animations, world, playerCollider, course);
  }

  update(dt: number, motor: MotorSnapshot): void {
    const footHeight = CONFIG.motor.capsuleHalfHeight + CONFIG.motor.capsuleRadius;
    this.root.position.set(motor.position.x, motor.position.y - footHeight, motor.position.z);
    this.root.rotation.set(0, motor.heading, 0);
    this.playState(motor.state, motor.speed);
    this.mixer.update(dt);
    this.root.updateMatrixWorld(true);

    this.updateFootIK(dt, motor);
    this.updateHandIK(dt, motor);
    this.root.updateMatrixWorld(true);
  }

  setDebugVisible(visible: boolean): void {
    this.debugVisible = visible;
    this.debugGroup.visible = visible;
  }

  get contactSummary(): string {
    const handContacts = this.hands.filter((hand) => hand.weight > 0.2).length;
    if (handContacts > 0) return handContacts === 2 ? 'DUAL CONTACT' : 'HAND CONTACT';
    if (this.feet.some((foot) => foot.weight > 0.55)) return 'IK LOCKED';
    return 'STABLE';
  }

  get debugSummary(): string {
    const footWeights = this.feet.map((foot) => foot.weight.toFixed(2)).join(' / ');
    const handWeights = this.hands.map((hand) => hand.weight.toFixed(2)).join(' / ');
    return `IK FOOT  ${footWeights}\nIK HAND  ${handWeights}\nPELVIS   ${this.pelvisOffset.toFixed(3)} m`;
  }

  get handDebug(): Array<{
    side: number;
    weight: number;
    contacting: boolean;
    probe: { x: number; y: number; z: number };
  }> {
    return this.hands.map((hand) => ({
      side: hand.side,
      weight: hand.weight,
      contacting: hand.contacting,
      probe: { x: hand.probeOrigin.x, y: hand.probeOrigin.y, z: hand.probeOrigin.z },
    }));
  }

  private createFootRuntime(
    side: -1 | 1,
    root: Bone,
    middle: Bone,
    end: Bone,
    geometry: SphereGeometry,
    markerMaterial: MeshBasicMaterial,
  ): FootRuntime {
    const position = end.getWorldPosition(new Vector3());
    const worldQuaternion = end.getWorldQuaternion(new Quaternion());
    const localUpAxis = new Vector3(0, 1, 0).applyQuaternion(worldQuaternion.clone().invert()).normalize();
    const marker = new Mesh(geometry, markerMaterial);
    marker.renderOrder = 20;
    this.debugGroup.add(marker);
    return {
      side,
      limb: { root, middle, end },
      target: position.clone(),
      normal: new Vector3(0, 1, 0),
      previousAnimatedPosition: position.clone(),
      lockedTarget: position.clone(),
      locked: false,
      weight: 0,
      localUpAxis,
      marker,
      hasGround: false,
    };
  }

  private createHandRuntime(
    side: -1 | 1,
    root: Bone,
    middle: Bone,
    end: Bone,
    geometry: SphereGeometry,
    markerMaterial: MeshBasicMaterial,
  ): HandRuntime {
    const position = end.getWorldPosition(new Vector3());
    const worldQuaternion = end.getWorldQuaternion(new Quaternion());
    const localPalmAxis = new Vector3(0, 0, 1).applyQuaternion(worldQuaternion.clone().invert()).normalize();
    const marker = new Mesh(geometry, markerMaterial);
    marker.renderOrder = 20;
    this.debugGroup.add(marker);
    return {
      side,
      limb: { root, middle, end },
      target: position.clone(),
      normal: new Vector3(0, 0, 1),
      weight: 0,
      localPalmAxis,
      marker,
      contacting: false,
      probeOrigin: position.clone(),
    };
  }

  private playState(state: LocomotionState, speed: number, immediate = false): void {
    const clipName = CLIP_FOR_STATE[state];
    const nextAction = this.actions.get(clipName);
    if (!nextAction) return;
    nextAction.setEffectiveTimeScale(animationSpeed(state, speed));
    if (this.activeState === state || this.activeAction === nextAction) {
      this.activeState = state;
      return;
    }

    nextAction.reset();
    nextAction.enabled = true;
    nextAction.clampWhenFinished = !LOOPING_STATES.has(state);
    nextAction.setLoop(LOOPING_STATES.has(state) ? LoopRepeat : LoopOnce, LOOPING_STATES.has(state) ? Infinity : 1);
    nextAction.setEffectiveWeight(1);
    nextAction.play();

    if (this.activeAction && !immediate) {
      const fade = state === 'jumpStart' || state === 'land' || state === 'hardLand' ? 0.1 : 0.18;
      this.activeAction.crossFadeTo(nextAction, fade, true);
    }
    this.activeAction = nextAction;
    this.activeState = state;
  }

  private updateFootIK(dt: number, motor: MotorSnapshot): void {
    const c = CONFIG.ik;
    let desiredPelvisOffset: number = c.maxPelvisRise;
    let groundedFeet = 0;

    for (const foot of this.feet) {
      const animatedPosition = foot.limb.end.getWorldPosition(new Vector3());
      const verticalMotion = Math.abs(animatedPosition.y - foot.previousAnimatedPosition.y) / Math.max(dt, 1 / 240);
      foot.previousAnimatedPosition.copy(animatedPosition);

      const rayOrigin = animatedPosition.clone().addScaledVector(new Vector3(0, 1, 0), c.footProbeUp);
      const ray = new RAPIER.Ray(rayOrigin, { x: 0, y: -1, z: 0 });
      const hit = this.world.castRayAndGetNormal(
        ray,
        c.footProbeLength,
        true,
        undefined,
        undefined,
        this.playerCollider,
      );
      foot.hasGround = Boolean(hit) && motor.grounded;
      let groundTarget = animatedPosition;

      if (hit && motor.grounded) {
        const hitPoint = ray.pointAt(hit.timeOfImpact);
        foot.normal.set(hit.normal.x, hit.normal.y, hit.normal.z).normalize();
        groundTarget = new Vector3(hitPoint.x, hitPoint.y, hitPoint.z).addScaledVector(
          foot.normal,
          c.ankleHeight,
        );
        const closeToGround = animatedPosition.distanceTo(groundTarget) < 0.31;
        const shouldPlant = motor.speed < 0.18 || (verticalMotion < 0.5 && closeToGround);

        if (shouldPlant && !foot.locked) {
          foot.locked = true;
          foot.lockedTarget.copy(groundTarget);
        }
        if (
          foot.locked &&
          (animatedPosition.distanceTo(foot.lockedTarget) > c.footReleaseDistance || verticalMotion > 1.15)
        ) {
          foot.locked = false;
        }

        const desired = foot.locked ? foot.lockedTarget : groundTarget;
        foot.target.lerp(desired, 1 - Math.exp(-c.footSharpness * dt));
        const targetWeight = foot.locked ? (motor.speed > 6.2 ? 0.72 : 1) : 0.22;
        foot.weight = damp(foot.weight, targetWeight, foot.locked ? 18 : 9, dt);
        desiredPelvisOffset = Math.min(
          desiredPelvisOffset,
          MathUtils.clamp(foot.target.y - animatedPosition.y, -c.maxPelvisDrop, c.maxPelvisRise),
        );
        groundedFeet += 1;
      } else {
        foot.locked = false;
        foot.weight = damp(foot.weight, 0, 13, dt);
      }
      foot.marker.position.copy(foot.target);
      foot.marker.visible = this.debugVisible && foot.hasGround;
    }

    if (groundedFeet === 0) desiredPelvisOffset = 0;
    this.pelvisOffset = damp(this.pelvisOffset, desiredPelvisOffset, c.pelvisSharpness, dt);
    this.translateBoneWorld(this.rig.pelvis, new Vector3(0, this.pelvisOffset, 0));
    this.root.updateMatrixWorld(true);

    const forward = new Vector3(Math.sin(motor.heading), 0, Math.cos(motor.heading));
    for (const foot of this.feet) {
      if (foot.weight < 0.005 || !foot.hasGround) continue;
      const hip = foot.limb.root.getWorldPosition(new Vector3());
      const pole = hip.clone().addScaledVector(forward, 0.62).add(new Vector3(foot.side * 0.08, 0, 0));
      this.solveTwoBone(foot.limb, foot.target, pole, foot.weight);
      this.alignBoneAxis(foot.limb.end, foot.localUpAxis, foot.normal, foot.weight * 0.72);
    }
  }

  private updateHandIK(dt: number, motor: MotorSnapshot): void {
    const forward = new Vector3(Math.sin(motor.heading), 0, Math.cos(motor.heading));

    for (const hand of this.hands) {
      const shoulder = hand.limb.root.getWorldPosition(new Vector3());
      const sideDirection = shoulder.clone().sub(this.root.position).setY(0).normalize();
      // Probe at palm/elbow height so both full walls and waist-high barriers are valid contacts.
      const origin = shoulder.clone().addScaledVector(forward, 0.1).add(new Vector3(0, -0.28, 0));
      hand.probeOrigin.copy(origin);
      const ray = new RAPIER.Ray(origin, sideDirection);
      const hit =
        motor.grounded && motor.speed > 0.32
          ? this.world.castRayAndGetNormal(
              ray,
              CONFIG.ik.handReach,
              true,
              undefined,
              undefined,
              this.playerCollider,
              undefined,
              (collider) => this.course.isHandContact(collider),
            )
          : null;

      hand.contacting = Boolean(hit);
      if (hit) {
        const point = ray.pointAt(hit.timeOfImpact);
        hand.normal.set(hit.normal.x, hit.normal.y, hit.normal.z).normalize();
        const target = new Vector3(point.x, point.y, point.z).addScaledVector(hand.normal, 0.035);
        hand.target.lerp(target, 1 - Math.exp(-CONFIG.ik.handSharpness * dt));
        hand.weight = damp(hand.weight, motor.speed > 6.2 ? 0.58 : 0.92, 11, dt);
      } else {
        hand.weight = damp(hand.weight, 0, 14, dt);
      }

      if (hand.weight > 0.01) {
        const pole = shoulder
          .clone()
          .addScaledVector(sideDirection, 0.46)
          .addScaledVector(forward, -0.28)
          .add(new Vector3(0, -0.12, 0));
        this.solveTwoBone(hand.limb, hand.target, pole, hand.weight);
        this.alignBoneAxis(
          hand.limb.end,
          hand.localPalmAxis,
          hand.normal.clone().negate(),
          hand.weight * 0.78,
        );
      }
      hand.marker.position.copy(hand.target);
      hand.marker.visible = this.debugVisible && hand.weight > 0.05;
    }
  }

  private solveTwoBone(limb: Limb, target: Vector3, pole: Vector3, weight: number): void {
    limb.root.updateWorldMatrix(true, true);
    limb.root.getWorldPosition(_start);
    limb.middle.getWorldPosition(_middle);
    limb.end.getWorldPosition(_end);

    const upperLength = _start.distanceTo(_middle);
    const lowerLength = _middle.distanceTo(_end);
    const requestedDistance = _start.distanceTo(target);
    const distance = MathUtils.clamp(
      requestedDistance,
      Math.abs(upperLength - lowerLength) + 0.001,
      upperLength + lowerLength - 0.003,
    );
    _direction.copy(target).sub(_start).normalize();
    _poleDirection.copy(pole).sub(_start);
    _poleDirection.addScaledVector(_direction, -_poleDirection.dot(_direction));
    if (_poleDirection.lengthSq() < 0.00001) {
      _poleDirection.set(0, 1, 0).cross(_direction);
    }
    _poleDirection.normalize();

    const along = (upperLength * upperLength + distance * distance - lowerLength * lowerLength) / (2 * distance);
    const perpendicular = Math.sqrt(Math.max(0, upperLength * upperLength - along * along));
    _desiredMiddle
      .copy(_start)
      .addScaledVector(_direction, along)
      .addScaledVector(_poleDirection, perpendicular);

    const rootAnimated = limb.root.quaternion.clone();
    const middleAnimated = limb.middle.quaternion.clone();
    this.rotateBoneToward(limb.root, _middle, _desiredMiddle);
    limb.root.updateWorldMatrix(true, true);
    limb.middle.getWorldPosition(_middle);
    limb.end.getWorldPosition(_end);
    this.rotateBoneToward(limb.middle, _end, target);

    const rootSolved = limb.root.quaternion.clone();
    const middleSolved = limb.middle.quaternion.clone();
    limb.root.quaternion.copy(rootAnimated).slerp(rootSolved, weight);
    limb.root.updateWorldMatrix(true, true);
    limb.middle.quaternion.copy(middleAnimated).slerp(middleSolved, weight);
    limb.middle.updateWorldMatrix(true, true);
  }

  private rotateBoneToward(bone: Bone, currentEnd: Vector3, desiredEnd: Vector3): void {
    bone.getWorldPosition(_start);
    _currentDirection.copy(currentEnd).sub(_start).normalize();
    _desiredDirection.copy(desiredEnd).sub(_start).normalize();
    if (_currentDirection.lengthSq() === 0 || _desiredDirection.lengthSq() === 0) return;

    bone.getWorldQuaternion(_currentWorldQuaternion);
    _deltaQuaternion.setFromUnitVectors(_currentDirection, _desiredDirection);
    _desiredWorldQuaternion.copy(_deltaQuaternion).multiply(_currentWorldQuaternion);
    if (bone.parent) bone.parent.getWorldQuaternion(_parentWorldQuaternion);
    else _parentWorldQuaternion.identity();
    _desiredLocalQuaternion
      .copy(_parentWorldQuaternion)
      .invert()
      .multiply(_desiredWorldQuaternion)
      .normalize();
    bone.quaternion.copy(_desiredLocalQuaternion);
  }

  private alignBoneAxis(bone: Bone, localAxis: Vector3, desiredAxis: Vector3, weight: number): void {
    bone.updateWorldMatrix(true, false);
    bone.getWorldQuaternion(_currentWorldQuaternion);
    _currentDirection.copy(localAxis).applyQuaternion(_currentWorldQuaternion).normalize();
    _desiredDirection.copy(desiredAxis).normalize();
    _deltaQuaternion.setFromUnitVectors(_currentDirection, _desiredDirection);
    _desiredWorldQuaternion.copy(_deltaQuaternion).multiply(_currentWorldQuaternion);
    if (bone.parent) bone.parent.getWorldQuaternion(_parentWorldQuaternion);
    else _parentWorldQuaternion.identity();
    _desiredLocalQuaternion
      .copy(_parentWorldQuaternion)
      .invert()
      .multiply(_desiredWorldQuaternion)
      .normalize();
    bone.quaternion.slerp(_desiredLocalQuaternion, MathUtils.clamp(weight, 0, 1));
  }

  private translateBoneWorld(bone: Bone, delta: Vector3): void {
    if (!bone.parent || delta.lengthSq() === 0) return;
    bone.parent.getWorldQuaternion(_parentWorldQuaternion);
    _inverseQuaternion.copy(_parentWorldQuaternion).invert();
    bone.position.add(delta.clone().applyQuaternion(_inverseQuaternion));
  }
}
