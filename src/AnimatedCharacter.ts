import RAPIER from '@dimforge/rapier3d-compat';
import {
  AnimationAction,
  AnimationClip,
  AnimationMixer,
  Bone,
  BoxGeometry,
  Group,
  LoopOnce,
  LoopRepeat,
  Matrix4,
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
import {
  cubicDecayCoefficients,
  hasContactMajority,
  isSourceFootContact,
  selectFootSupport,
  solveFootbase,
  solveLimbReach,
  solvePelvisReachOffset,
  type FootSupportSample,
  type LegReachConstraint,
  type LimbReachResult,
  type LimbReachability,
} from './ik';
import { damp } from './math';

interface Rig {
  pelvis: Bone;
  thighL: Bone;
  calfL: Bone;
  footL: Bone;
  ballL: Bone;
  ballLeafL: Bone;
  thighR: Bone;
  calfR: Bone;
  footR: Bone;
  ballR: Bone;
  ballLeafR: Bone;
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
  upperLength: number;
  lowerLength: number;
  minimumLength: number;
  maximumLength: number;
}

interface BonePoseSnapshot {
  bone: Bone;
  position: Vector3;
  quaternion: Quaternion;
  scale: Vector3;
}

type SoleProbeRole = 'anchor' | 'heel' | 'toe' | 'inside' | 'outside';

interface SoleProbeRuntime {
  role: SoleProbeRole;
  position: Vector3;
  point: Vector3;
  normal: Vector3;
  colliderHandle: number | null;
}

interface FootRuntime {
  side: -1 | 1;
  limb: Limb;
  toe: Bone;
  toeEnd: Bone;
  target: Vector3;
  heelTarget: Vector3;
  reachableHeelTarget: Vector3;
  reachableToeTarget: Vector3;
  normal: Vector3;
  probeNormal: Vector3;
  lockedNormal: Vector3;
  forward: Vector3;
  probeForward: Vector3;
  lockedForward: Vector3;
  groundPoint: Vector3;
  animatedHeelContact: Vector3;
  animatedToeContact: Vector3;
  inputHeelGround: Vector3;
  inputToeGround: Vector3;
  targetHeelGround: Vector3;
  targetToeGround: Vector3;
  animatedHip: Vector3;
  animatedKnee: Vector3;
  animatedHeel: Vector3;
  animatedToe: Vector3;
  animatedToeEnd: Vector3;
  animatedVelocity: Vector3;
  previousAnimatedPosition: Vector3;
  inputTarget: Vector3;
  previousInputTarget: Vector3;
  inputVelocity: Vector3;
  outputVelocity: Vector3;
  transitionOffset: Vector3;
  transitionVelocity: Vector3;
  transitionElapsed: number;
  transitionDuration: number;
  lockedTarget: Vector3;
  lockedSupportLocalTarget: Vector3;
  lockedSupportLocalNormal: Vector3;
  lockedSupportLocalForward: Vector3;
  locked: boolean;
  contactSamples: boolean[];
  contactConfidence: number;
  weight: number;
  localUpAxis: Vector3;
  kneeSideLocal: Vector3;
  toeClearance: number;
  toeEndClearance: number;
  heelClearance: number;
  footLength: number;
  heelToBallLength: number;
  soleHalfWidth: number;
  footbaseBalance: number;
  animatedReach: number;
  geometricReach: number;
  unmetReach: number;
  reachability: LimbReachability;
  reachWeight: number;
  extensionRatio: number;
  sourceContact: boolean;
  actualToe: Vector3;
  contactError: number;
  reachConstraint: LegReachConstraint;
  marker: Mesh;
  heelMarker: Mesh;
  toeMarker: Mesh;
  footprintMarker: Mesh;
  hasGround: boolean;
  soleProbes: SoleProbeRuntime[];
  supportColliderHandle: number | null;
  lockedSupportColliderHandle: number | null;
  supportCount: number;
  supportLedge: boolean;
  footprintShape: RAPIER.Cuboid;
  footprintSupported: boolean;
  footprintColliderHandle: number | null;
  supportIsMoving: boolean;
  supportKind: 'none' | 'continuous' | 'ledge' | 'blocked';
  clearanceLift: number;
  clearanceWeight: number;
  clearanceBlocked: boolean;
  postSolveBlocked: boolean;
  initialized: boolean;
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
const _worldUp = new Vector3(0, 1, 0);
const _rayOrigin = new Vector3();
const _kneeSide = new Vector3();
const _bendDirection = new Vector3();
const _softTarget = new Vector3();
const _pelvisDelta = new Vector3();
const _toeEndCorrection = new Vector3();
const _footUp = new Vector3();
const _footForward = new Vector3();
const _footSide = new Vector3();
const _soleHeel = new Vector3();
const _soleMiddle = new Vector3();
const _supportPoint = new Vector3();
const _supportNormal = new Vector3();
const _clearanceCandidate = new Vector3();
const _candidateToe = new Vector3();
const _clearanceVelocity = new Vector3();
const _actualKnee = new Vector3();
const _actualHeel = new Vector3();
const _actualToeEnd = new Vector3();
const _animatedPivot = new Vector3();
const _groundPivot = new Vector3();
const _supportTranslation = new Vector3();
const _supportRotation = new Quaternion();
const _footprintOrigin = new Vector3();
const _footprintVelocity = new Vector3();
const _footprintRotation = new Quaternion();
const _footprintBasis = new Matrix4();
const _footprintPoint = new Vector3();
const _footprintNormal = new Vector3();
const IDENTITY_ROTATION = { x: 0, y: 0, z: 0, w: 1 } as const;

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
  private readonly animatedPose: BonePoseSnapshot[];
  private readonly animatedPoseByBone: Map<Bone, BonePoseSnapshot>;
  private readonly pelvisConstraints: LegReachConstraint[] = [];
  private activeAction: AnimationAction | null = null;
  private activeState: LocomotionState | null = null;
  private pelvisOffset = 0;
  private pelvisWeight: number = CONFIG.ik.pelvisWeight;
  private previousHeading = 0;
  private headingInitialized = false;
  private debugVisible = false;
  private readonly ankleClearanceShape = new RAPIER.Ball(CONFIG.ik.ankleClearanceRadius);
  private readonly shinClearanceShape = new RAPIER.Ball(CONFIG.ik.shinClearanceRadius);

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
      ballL: requireBone(this.root, 'ball_l'),
      ballLeafL: requireBone(this.root, 'ball_leaf_l'),
      thighR: requireBone(this.root, 'thigh_r'),
      calfR: requireBone(this.root, 'calf_r'),
      footR: requireBone(this.root, 'foot_r'),
      ballR: requireBone(this.root, 'ball_r'),
      ballLeafR: requireBone(this.root, 'ball_leaf_r'),
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

    // Calibrate limb axes from an authored animation pose rather than the
    // nearly straight bind pose, which is a degenerate state for leg solvers.
    this.playState('idle', 0, true);
    this.mixer.update(0);

    const markerGeometry = new SphereGeometry(0.055, 8, 6);
    const footMaterial = new MeshBasicMaterial({ color: PALETTE.acid, depthTest: false });
    const handMaterial = new MeshBasicMaterial({ color: PALETTE.accent, depthTest: false });
    this.root.updateMatrixWorld(true);

    this.feet = [
      this.createFootRuntime(
        -1,
        this.rig.thighL,
        this.rig.calfL,
        this.rig.footL,
        this.rig.ballL,
        this.rig.ballLeafL,
        markerGeometry,
        footMaterial,
      ),
      this.createFootRuntime(
        1,
        this.rig.thighR,
        this.rig.calfR,
        this.rig.footR,
        this.rig.ballR,
        this.rig.ballLeafR,
        markerGeometry,
        footMaterial,
      ),
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
    this.animatedPose = [...new Set(Object.values(this.rig))].map((bone) => ({
      bone,
      position: bone.position.clone(),
      quaternion: bone.quaternion.clone(),
      scale: bone.scale.clone(),
    }));
    this.animatedPoseByBone = new Map(this.animatedPose.map((pose) => [pose.bone, pose]));
    this.captureAnimatedPose();
    this.debugGroup.name = 'IK targets';
    this.debugGroup.visible = false;
    scene.add(this.debugGroup);
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
    this.restoreAnimatedPose();
    const footHeight = CONFIG.motor.capsuleHalfHeight + CONFIG.motor.capsuleRadius;
    this.root.position.set(motor.position.x, motor.position.y - footHeight, motor.position.z);
    this.root.rotation.set(0, motor.heading, 0);
    this.playState(motor.state, motor.speed);
    this.mixer.update(dt);
    this.root.updateMatrixWorld(true);
    this.captureAnimatedPose();

    const turnRate = this.headingInitialized
      ? Math.abs(Math.atan2(Math.sin(motor.heading - this.previousHeading), Math.cos(motor.heading - this.previousHeading))) /
        Math.max(dt, 1 / 240)
      : 0;
    this.previousHeading = motor.heading;
    this.headingInitialized = true;

    this.updateFootIK(dt, motor, turnRate);
    this.updateHandIK(dt, motor);
    this.root.updateMatrixWorld(true);
  }

  resetIK(motor?: MotorSnapshot): void {
    this.pelvisOffset = 0;
    this.previousHeading = motor?.heading ?? 0;
    this.headingInitialized = Boolean(motor);
    for (const foot of this.feet) {
      foot.locked = false;
      foot.contactSamples.length = 0;
      foot.contactConfidence = 0;
      foot.weight = 0;
      foot.transitionElapsed = 0;
      foot.transitionDuration = 0;
      foot.outputVelocity.set(0, 0, 0);
      foot.inputVelocity.set(0, 0, 0);
      foot.animatedVelocity.set(0, 0, 0);
      foot.hasGround = false;
      foot.supportColliderHandle = null;
      foot.lockedSupportColliderHandle = null;
      foot.supportCount = 0;
      foot.supportLedge = false;
      foot.footprintSupported = false;
      foot.footprintColliderHandle = null;
      foot.supportIsMoving = false;
      foot.supportKind = 'none';
      foot.clearanceLift = 0;
      foot.clearanceWeight = 0;
      foot.clearanceBlocked = false;
      foot.postSolveBlocked = false;
      foot.initialized = false;
      foot.unmetReach = 0;
      foot.reachability = 'reachable';
      foot.reachWeight = 1;
      foot.extensionRatio = 0;
      foot.sourceContact = false;
      foot.contactError = 0;
      foot.marker.visible = false;
      foot.heelMarker.visible = false;
      foot.toeMarker.visible = false;
      foot.footprintMarker.visible = false;
    }
    for (const hand of this.hands) {
      hand.weight = 0;
      hand.contacting = false;
      hand.marker.visible = false;
    }
  }

  setPelvisIKWeight(weight: number): void {
    this.pelvisWeight = MathUtils.clamp(weight, 0, 1);
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
    const reach = this.feet.map((foot) => foot.reachability).join(' / ');
    const handWeights = this.hands.map((hand) => hand.weight.toFixed(2)).join(' / ');
    return `IK FOOT  ${footWeights}\nREACH     ${reach}\nIK HAND  ${handWeights}\nPELVIS   ${this.pelvisOffset.toFixed(3)} m`;
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

  get footDebug(): Array<{
    side: number;
    weight: number;
    locked: boolean;
    contact: number;
    sourceContact: boolean;
    hasGround: boolean;
    toeSpeed: number;
    unmetReach: number;
    reachability: LimbReachability;
    extensionRatio: number;
    contactError: number;
    supportColliderHandle: number | null;
    supportCount: number;
    supportLedge: boolean;
    footprintSupported: boolean;
    supportIsMoving: boolean;
    footbaseBalance: number;
    supportKind: FootRuntime['supportKind'];
    clearanceLift: number;
    clearanceWeight: number;
    clearanceBlocked: boolean;
    postSolveBlocked: boolean;
    target: { x: number; y: number; z: number };
    actualToe: { x: number; y: number; z: number };
  }> {
    return this.feet.map((foot) => ({
      side: foot.side,
      weight: foot.weight,
      locked: foot.locked,
      contact: foot.contactConfidence,
      sourceContact: foot.sourceContact,
      hasGround: foot.hasGround,
      toeSpeed: foot.animatedVelocity.length(),
      unmetReach: foot.unmetReach,
      reachability: foot.reachability,
      extensionRatio: foot.extensionRatio,
      contactError: foot.contactError,
      supportColliderHandle: foot.supportColliderHandle,
      supportCount: foot.supportCount,
      supportLedge: foot.supportLedge,
      footprintSupported: foot.footprintSupported,
      supportIsMoving: foot.supportIsMoving,
      footbaseBalance: foot.footbaseBalance,
      supportKind: foot.supportKind,
      clearanceLift: foot.clearanceLift,
      clearanceWeight: foot.clearanceWeight,
      clearanceBlocked: foot.clearanceBlocked,
      postSolveBlocked: foot.postSolveBlocked,
      target: { x: foot.target.x, y: foot.target.y, z: foot.target.z },
      actualToe: { x: foot.actualToe.x, y: foot.actualToe.y, z: foot.actualToe.z },
    }));
  }

  private createFootRuntime(
    side: -1 | 1,
    root: Bone,
    middle: Bone,
    end: Bone,
    toe: Bone,
    toeEnd: Bone,
    geometry: SphereGeometry,
    markerMaterial: MeshBasicMaterial,
  ): FootRuntime {
    const heelPosition = end.getWorldPosition(new Vector3());
    const toePosition = toe.getWorldPosition(new Vector3());
    const toeEndPosition = toeEnd.getWorldPosition(new Vector3());
    const rootPosition = root.getWorldPosition(new Vector3());
    const middlePosition = middle.getWorldPosition(new Vector3());
    const modelPosition = this.root.getWorldPosition(new Vector3());
    const worldQuaternion = end.getWorldQuaternion(new Quaternion());
    const localUpAxis = new Vector3(0, 1, 0).applyQuaternion(worldQuaternion.clone().invert()).normalize();
    const worldUpAxis = localUpAxis.clone().applyQuaternion(worldQuaternion).normalize();
    const toeClearance = MathUtils.clamp(toePosition.y - modelPosition.y, 0.008, 0.06);
    const toeEndClearance = MathUtils.clamp(toeEndPosition.y - modelPosition.y, 0.008, 0.06);
    const heelClearance = MathUtils.clamp(heelPosition.y - modelPosition.y, 0.045, 0.18);
    const animatedHeelContact = heelPosition.clone().addScaledVector(worldUpAxis, -heelClearance);
    const animatedToeContact = toeEndPosition.clone().addScaledVector(worldUpAxis, -toeEndClearance);
    const measuredForward = animatedToeContact
      .clone()
      .sub(animatedHeelContact)
      .addScaledVector(worldUpAxis, -animatedToeContact.clone().sub(animatedHeelContact).dot(worldUpAxis));
    const footLength = Math.max(0.12, measuredForward.length());
    measuredForward.normalize();
    const heelToBallLength = MathUtils.clamp(
      toePosition.clone().sub(animatedHeelContact).dot(measuredForward),
      footLength * 0.35,
      footLength * 0.9,
    );
    const upperLength = rootPosition.distanceTo(middlePosition);
    const lowerLength = middlePosition.distanceTo(heelPosition);
    const maximumLength = upperLength + lowerLength - 0.003;
    const minimumLength = Math.abs(upperLength - lowerLength) + 0.001;
    const soleHalfWidth = Math.min(CONFIG.ik.soleHalfWidth, footLength * 0.32);
    const rootWorldQuaternion = root.getWorldQuaternion(new Quaternion());
    const chainAxis = heelPosition.clone().sub(rootPosition).normalize();
    const bendDirection = middlePosition
      .clone()
      .sub(rootPosition)
      .addScaledVector(chainAxis, -middlePosition.clone().sub(rootPosition).dot(chainAxis));
    if (bendDirection.lengthSq() < 0.000001) {
      bendDirection.set(0, 0, 1).addScaledVector(chainAxis, -chainAxis.z);
    }
    bendDirection.normalize();
    const kneeSideLocal = chainAxis
      .clone()
      .cross(bendDirection)
      .normalize()
      .applyQuaternion(rootWorldQuaternion.clone().invert());
    const marker = new Mesh(geometry, markerMaterial);
    marker.renderOrder = 20;
    this.debugGroup.add(marker);
    const heelMarker = new Mesh(geometry, markerMaterial);
    const toeMarker = new Mesh(geometry, markerMaterial);
    heelMarker.scale.setScalar(0.62);
    toeMarker.scale.setScalar(0.62);
    heelMarker.renderOrder = 20;
    toeMarker.renderOrder = 20;
    this.debugGroup.add(heelMarker, toeMarker);
    const footprintMarker = new Mesh(
      new BoxGeometry(soleHalfWidth * 2, CONFIG.ik.footprintHalfThickness * 2, footLength),
      new MeshBasicMaterial({ color: PALETTE.acid, wireframe: true, depthTest: false }),
    );
    footprintMarker.renderOrder = 19;
    this.debugGroup.add(footprintMarker);
    return {
      side,
      limb: { root, middle, end, upperLength, lowerLength, minimumLength, maximumLength },
      toe,
      toeEnd,
      target: toePosition.clone(),
      heelTarget: heelPosition.clone(),
      reachableHeelTarget: heelPosition.clone(),
      reachableToeTarget: toePosition.clone(),
      normal: new Vector3(0, 1, 0),
      probeNormal: new Vector3(0, 1, 0),
      lockedNormal: new Vector3(0, 1, 0),
      forward: measuredForward.clone(),
      probeForward: measuredForward.clone(),
      lockedForward: measuredForward.clone(),
      groundPoint: toePosition.clone().setY(modelPosition.y),
      animatedHeelContact,
      animatedToeContact,
      inputHeelGround: animatedHeelContact.clone(),
      inputToeGround: animatedToeContact.clone(),
      targetHeelGround: animatedHeelContact.clone(),
      targetToeGround: animatedToeContact.clone(),
      animatedHip: rootPosition.clone(),
      animatedKnee: middlePosition.clone(),
      animatedHeel: heelPosition.clone(),
      animatedToe: toePosition.clone(),
      animatedToeEnd: toeEndPosition.clone(),
      animatedVelocity: new Vector3(),
      previousAnimatedPosition: toePosition.clone(),
      inputTarget: toePosition.clone(),
      previousInputTarget: toePosition.clone(),
      inputVelocity: new Vector3(),
      outputVelocity: new Vector3(),
      transitionOffset: new Vector3(),
      transitionVelocity: new Vector3(),
      transitionElapsed: 0,
      transitionDuration: 0,
      lockedTarget: toePosition.clone(),
      lockedSupportLocalTarget: toePosition.clone(),
      lockedSupportLocalNormal: new Vector3(0, 1, 0),
      lockedSupportLocalForward: measuredForward.clone(),
      locked: false,
      contactSamples: [],
      contactConfidence: 0,
      weight: 0,
      localUpAxis,
      kneeSideLocal,
      toeClearance,
      toeEndClearance,
      heelClearance,
      footLength,
      heelToBallLength,
      soleHalfWidth,
      footbaseBalance: 0.5,
      animatedReach: rootPosition.distanceTo(heelPosition),
      geometricReach: maximumLength,
      unmetReach: 0,
      reachability: 'reachable',
      reachWeight: 1,
      extensionRatio: 0,
      sourceContact: false,
      actualToe: toePosition.clone(),
      contactError: 0,
      reachConstraint: {
        hipY: rootPosition.y,
        targetY: heelPosition.y,
        horizontalDistance: 0,
        preferredLength: rootPosition.distanceTo(heelPosition),
        maximumLength:
          rootPosition.distanceTo(middlePosition) + middlePosition.distanceTo(heelPosition) - 0.003,
      },
      marker,
      heelMarker,
      toeMarker,
      footprintMarker,
      hasGround: false,
      soleProbes: (['anchor', 'heel', 'toe', 'inside', 'outside'] as const).map((role) => ({
        role,
        position: toePosition.clone(),
        point: toePosition.clone(),
        normal: new Vector3(0, 1, 0),
        colliderHandle: null,
      })),
      supportColliderHandle: null,
      lockedSupportColliderHandle: null,
      supportCount: 0,
      supportLedge: false,
      footprintShape: new RAPIER.Cuboid(
        soleHalfWidth * CONFIG.ik.footprintWidthScale,
        CONFIG.ik.footprintHalfThickness,
        footLength * CONFIG.ik.footprintLengthScale * 0.5,
      ),
      footprintSupported: false,
      footprintColliderHandle: null,
      supportIsMoving: false,
      supportKind: 'none',
      clearanceLift: 0,
      clearanceWeight: 0,
      clearanceBlocked: false,
      postSolveBlocked: false,
      initialized: false,
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
    const rootPosition = root.getWorldPosition(new Vector3());
    const middlePosition = middle.getWorldPosition(new Vector3());
    const upperLength = rootPosition.distanceTo(middlePosition);
    const lowerLength = middlePosition.distanceTo(position);
    const maximumLength = upperLength + lowerLength - 0.003;
    const worldQuaternion = end.getWorldQuaternion(new Quaternion());
    const localPalmAxis = new Vector3(0, 0, 1).applyQuaternion(worldQuaternion.clone().invert()).normalize();
    const marker = new Mesh(geometry, markerMaterial);
    marker.renderOrder = 20;
    this.debugGroup.add(marker);
    return {
      side,
      limb: {
        root,
        middle,
        end,
        upperLength,
        lowerLength,
        minimumLength: Math.abs(upperLength - lowerLength) + 0.001,
        maximumLength,
      },
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

  private captureAnimatedPose(): void {
    for (const pose of this.animatedPose) {
      pose.position.copy(pose.bone.position);
      pose.quaternion.copy(pose.bone.quaternion);
      pose.scale.copy(pose.bone.scale);
    }
  }

  private restoreAnimatedPose(): void {
    if (!this.animatedPose) return;
    for (const pose of this.animatedPose) {
      pose.bone.position.copy(pose.position);
      pose.bone.quaternion.copy(pose.quaternion);
      pose.bone.scale.copy(pose.scale);
    }
    this.root.updateMatrixWorld(true);
  }

  private restoreFootPose(foot: FootRuntime): void {
    const bones = [foot.limb.root, foot.limb.middle, foot.limb.end, foot.toe];
    for (const bone of bones) {
      const pose = this.animatedPoseByBone.get(bone);
      if (!pose) continue;
      bone.position.copy(pose.position);
      bone.quaternion.copy(pose.quaternion);
      bone.scale.copy(pose.scale);
    }
    foot.limb.root.updateWorldMatrix(true, true);
  }

  private projectToSupportPlane(
    position: Vector3,
    planePoint: Vector3,
    planeNormal: Vector3,
    target: Vector3,
  ): Vector3 {
    const projectedY =
      planePoint.y -
      (planeNormal.x * (position.x - planePoint.x) +
        planeNormal.z * (position.z - planePoint.z)) /
        Math.max(0.001, planeNormal.y);
    return target.set(position.x, projectedY, position.z);
  }

  private updateFootIK(dt: number, motor: MotorSnapshot, turnRate: number): void {
    this.probeFootContacts(dt, motor);
    this.updateFootLocks(dt, motor, turnRate);
    this.resolveFootClearance(dt);
    this.solvePelvis(dt);
    this.solveLegs(dt);
  }

  private probeFootContacts(dt: number, motor: MotorSnapshot): void {
    const c = CONFIG.ik;
    const safeDt = Math.max(dt, 1 / 240);
    for (const foot of this.feet) {
      foot.animatedHip.copy(foot.limb.root.getWorldPosition(_start));
      foot.animatedKnee.copy(foot.limb.middle.getWorldPosition(_middle));
      foot.animatedHeel.copy(foot.limb.end.getWorldPosition(_end));
      foot.animatedToe.copy(foot.toe.getWorldPosition(_direction));
      foot.animatedToeEnd.copy(foot.toeEnd.getWorldPosition(_desiredMiddle));
      foot.animatedReach = foot.animatedHip.distanceTo(foot.animatedHeel);
      foot.geometricReach = foot.limb.maximumLength;

      if (!foot.initialized) {
        foot.previousAnimatedPosition.copy(foot.animatedToeEnd);
        foot.previousInputTarget.copy(foot.animatedToeEnd);
        foot.target.copy(foot.animatedToeEnd);
        foot.inputTarget.copy(foot.animatedToeEnd);
        foot.initialized = true;
      }
      foot.animatedVelocity
        .copy(foot.animatedToeEnd)
        .sub(foot.previousAnimatedPosition)
        .multiplyScalar(1 / safeDt);
      foot.previousAnimatedPosition.copy(foot.animatedToeEnd);
      const sourceHeight = foot.animatedToeEnd.y - this.root.position.y - foot.toeEndClearance;
      const rawContact = isSourceFootContact(
        foot.animatedVelocity.length(),
        sourceHeight,
        c.contactVelocity,
        c.contactHeight,
      );

      this.positionSoleProbes(foot);
      const supportSamples: FootSupportSample[] = [];
      for (const probe of foot.soleProbes) {
        probe.colliderHandle = null;
        _rayOrigin.copy(probe.position).addScaledVector(_worldUp, c.footProbeUp);
        const ray = new RAPIER.Ray(_rayOrigin, { x: 0, y: -1, z: 0 });
        const hit = this.world.castRayAndGetNormal(
          ray,
          c.footProbeLength,
          true,
          undefined,
          undefined,
          this.playerCollider,
          undefined,
          (collider) => this.course.isFootSupport(collider),
        );
        if (!hit || !motor.grounded) continue;
        const point = ray.pointAt(hit.timeOfImpact);
        probe.point.set(point.x, point.y, point.z);
        probe.normal.set(hit.normal.x, hit.normal.y, hit.normal.z).normalize();
        probe.colliderHandle = hit.collider.handle;
        supportSamples.push({
          colliderHandle: hit.collider.handle,
          height: point.y,
          normalY: probe.normal.y,
          isAnchor: probe.role === 'anchor',
        });
      }

      _footSide.crossVectors(_worldUp, foot.probeForward).normalize();
      _footprintBasis.makeBasis(_footSide, _worldUp, foot.probeForward);
      _footprintRotation.setFromRotationMatrix(_footprintBasis).normalize();
      _footprintOrigin
        .copy(foot.animatedHeelContact)
        .lerp(foot.animatedToeContact, 0.5)
        .addScaledVector(_worldUp, c.footProbeUp);
      _footprintVelocity.set(0, -c.footProbeLength, 0);
      const footprintHit = motor.grounded
        ? this.world.castShape(
            _footprintOrigin,
            _footprintRotation,
            _footprintVelocity,
            foot.footprintShape,
            0.006,
            1,
            true,
            undefined,
            undefined,
            this.playerCollider,
            undefined,
            (collider) => this.course.isFootSupport(collider),
          )
        : null;
      const footprintNormalY = footprintHit?.normal1.y ?? -1;
      foot.footprintSupported = Boolean(footprintHit && footprintNormalY >= c.minimumSupportNormalY);
      foot.footprintColliderHandle = foot.footprintSupported ? footprintHit!.collider.handle : null;
      if (foot.footprintSupported) {
        supportSamples.push({
          colliderHandle: footprintHit!.collider.handle,
          height: footprintHit!.witness1.y,
          normalY: footprintNormalY,
          isAnchor: true,
        });
      }

      const selection = selectFootSupport(
        supportSamples,
        foot.locked ? foot.lockedSupportColliderHandle : null,
        c.supportHeightTolerance,
        c.minimumSupportNormalY,
        c.minimumSoleSupportSamples,
      );
      foot.supportColliderHandle = selection.colliderHandle;
      foot.supportCount = selection.supportCount;
      foot.supportLedge = selection.isLedge;
      foot.supportKind = selection.colliderHandle === null
        ? 'none'
        : selection.isLedge
          ? 'ledge'
          : 'continuous';
      const lockedSupportVisible =
        foot.locked && selection.colliderHandle === foot.lockedSupportColliderHandle;
      foot.hasGround =
        motor.grounded &&
        selection.colliderHandle !== null &&
        (selection.supportCount >= c.minimumSoleSupportSamples ||
          lockedSupportVisible ||
          (foot.footprintSupported && foot.footprintColliderHandle === selection.colliderHandle));

      if (foot.hasGround && selection.colliderHandle !== null) {
        _supportPoint.set(0, 0, 0);
        _supportNormal.set(0, 0, 0);
        let selectedProbeCount = 0;
        for (const probe of foot.soleProbes) {
          if (probe.colliderHandle !== selection.colliderHandle) continue;
          _supportPoint.add(probe.point);
          _supportNormal.add(probe.normal);
          selectedProbeCount += 1;
        }
        if (
          footprintHit &&
          footprintHit.collider.handle === selection.colliderHandle
        ) {
          _footprintPoint.set(
            footprintHit.witness1.x,
            footprintHit.witness1.y,
            footprintHit.witness1.z,
          );
          _footprintNormal.set(
            footprintHit.normal1.x,
            footprintHit.normal1.y,
            footprintHit.normal1.z,
          );
          _supportPoint.add(_footprintPoint);
          _supportNormal.add(_footprintNormal);
          selectedProbeCount += 1;
        }
        _supportPoint.multiplyScalar(1 / Math.max(1, selectedProbeCount));
        _supportNormal.multiplyScalar(1 / Math.max(1, selectedProbeCount)).normalize();
        foot.probeNormal.copy(_supportNormal);

        this.projectToSupportPlane(
          foot.animatedHeelContact,
          _supportPoint,
          _supportNormal,
          foot.inputHeelGround,
        );
        this.projectToSupportPlane(
          foot.animatedToeContact,
          _supportPoint,
          _supportNormal,
          foot.inputToeGround,
        );
        const heelHeight = _supportNormal.dot(
          _direction.copy(foot.animatedHeelContact).sub(foot.inputHeelGround),
        );
        const toeHeight = _supportNormal.dot(
          _direction.copy(foot.animatedToeContact).sub(foot.inputToeGround),
        );
        const animatedBase = solveFootbase(
          foot.animatedHeelContact,
          foot.animatedToeContact,
          heelHeight,
          toeHeight,
          foot.footLength,
          c.footbaseAlpha,
          _animatedPivot,
        );
        foot.footbaseBalance = animatedBase.balance;
        this.projectToSupportPlane(animatedBase.pivot, _supportPoint, _supportNormal, _groundPivot);
        // The character controller deliberately keeps its capsule one skin-width
        // away from geometry. Project the planted footbase onto the actual
        // support plane so that clearance is not inherited by the visible rig.
        foot.inputTarget.copy(_groundPivot);

        foot.probeForward
          .copy(foot.animatedToeContact)
          .sub(foot.animatedHeelContact)
          .addScaledVector(_supportNormal, -_direction.copy(foot.animatedToeContact)
            .sub(foot.animatedHeelContact)
            .dot(_supportNormal));
        if (foot.probeForward.lengthSq() < 0.000001) {
          foot.probeForward.set(0, 0, 1).applyQuaternion(this.root.quaternion);
        }
        foot.probeForward.normalize();
        foot.inputHeelGround
          .copy(foot.inputTarget)
          .addScaledVector(foot.probeForward, -foot.footLength * foot.footbaseBalance);
        foot.inputToeGround
          .copy(foot.inputTarget)
          .addScaledVector(foot.probeForward, foot.footLength * (1 - foot.footbaseBalance));
        foot.groundPoint
          .copy(foot.inputHeelGround)
          .addScaledVector(foot.probeForward, foot.heelToBallLength);

        const supportCollider = this.world.getCollider(selection.colliderHandle);
        foot.supportIsMoving =
          supportCollider.parent()?.bodyType() !== RAPIER.RigidBodyType.Fixed;
      } else {
        const animatedBase = solveFootbase(
          foot.animatedHeelContact,
          foot.animatedToeContact,
          0,
          0,
          foot.footLength,
          c.footbaseAlpha,
          _animatedPivot,
        );
        foot.footbaseBalance = animatedBase.balance;
        foot.inputTarget.copy(animatedBase.pivot);
        foot.probeNormal.copy(_worldUp);
        foot.supportIsMoving = false;
      }

      foot.contactSamples.push(rawContact);
      while (foot.contactSamples.length > c.contactHistoryFrames) foot.contactSamples.shift();
      const filteredContact = hasContactMajority(foot.contactSamples);
      foot.sourceContact = filteredContact;
      foot.contactConfidence = damp(
        foot.contactConfidence,
        filteredContact ? 1 : 0,
        filteredContact ? 28 : 15,
        dt,
      );
      foot.inputVelocity.copy(foot.inputTarget).sub(foot.previousInputTarget).multiplyScalar(1 / safeDt);
      foot.previousInputTarget.copy(foot.inputTarget);
    }
  }

  private positionSoleProbes(foot: FootRuntime): void {
    foot.limb.end.getWorldQuaternion(_currentWorldQuaternion);
    _footUp.copy(foot.localUpAxis).applyQuaternion(_currentWorldQuaternion).normalize();
    _soleHeel.copy(foot.animatedHeel).addScaledVector(_footUp, -foot.heelClearance);
    foot.animatedHeelContact.copy(_soleHeel);
    foot.animatedToeContact
      .copy(foot.animatedToeEnd)
      .addScaledVector(_footUp, -foot.toeEndClearance);
    _footForward.copy(foot.animatedToeContact).sub(_soleHeel);
    _footForward.addScaledVector(_footUp, -_footForward.dot(_footUp));
    if (_footForward.lengthSq() < 0.000001) {
      _footForward.copy(foot.animatedToeEnd).sub(foot.animatedToe);
      _footForward.addScaledVector(_footUp, -_footForward.dot(_footUp));
    }
    if (_footForward.lengthSq() < 0.000001) _footForward.set(0, 0, 1).applyQuaternion(this.root.quaternion);
    _footForward.normalize();
    foot.probeForward.copy(_footForward);
    _footSide.crossVectors(_footUp, _footForward).normalize();
    _soleMiddle.copy(_soleHeel).lerp(foot.animatedToeContact, 0.52);

    for (const probe of foot.soleProbes) {
      if (probe.role === 'anchor') probe.position.copy(foot.animatedToe);
      else if (probe.role === 'heel') probe.position.copy(_soleHeel).addScaledVector(_footForward, 0.018);
      else if (probe.role === 'toe') probe.position.copy(foot.animatedToeContact).addScaledVector(_footForward, -0.012);
      else {
        probe.position
          .copy(_soleMiddle)
          .addScaledVector(_footSide, probe.role === 'inside' ? foot.soleHalfWidth : -foot.soleHalfWidth);
      }
    }
  }

  private storeFootLockInSupportSpace(foot: FootRuntime): void {
    if (foot.lockedSupportColliderHandle === null) return;
    const collider = this.world.getCollider(foot.lockedSupportColliderHandle);
    const translation = collider.translation();
    const rotation = collider.rotation();
    _supportTranslation.set(translation.x, translation.y, translation.z);
    _supportRotation.set(rotation.x, rotation.y, rotation.z, rotation.w).normalize();
    _inverseQuaternion.copy(_supportRotation).invert();
    foot.lockedSupportLocalTarget
      .copy(foot.lockedTarget)
      .sub(_supportTranslation)
      .applyQuaternion(_inverseQuaternion);
    foot.lockedSupportLocalNormal
      .copy(foot.lockedNormal)
      .applyQuaternion(_inverseQuaternion)
      .normalize();
    foot.lockedSupportLocalForward
      .copy(foot.lockedForward)
      .applyQuaternion(_inverseQuaternion)
      .normalize();
  }

  private refreshFootLockFromSupport(foot: FootRuntime): void {
    if (!foot.locked || foot.lockedSupportColliderHandle === null) return;
    const collider = this.world.getCollider(foot.lockedSupportColliderHandle);
    const translation = collider.translation();
    const rotation = collider.rotation();
    _supportTranslation.set(translation.x, translation.y, translation.z);
    _supportRotation.set(rotation.x, rotation.y, rotation.z, rotation.w).normalize();
    foot.lockedTarget
      .copy(foot.lockedSupportLocalTarget)
      .applyQuaternion(_supportRotation)
      .add(_supportTranslation);
    foot.lockedNormal
      .copy(foot.lockedSupportLocalNormal)
      .applyQuaternion(_supportRotation)
      .normalize();
    foot.lockedForward
      .copy(foot.lockedSupportLocalForward)
      .applyQuaternion(_supportRotation)
      .normalize();
    foot.supportIsMoving = collider.parent()?.bodyType() !== RAPIER.RigidBodyType.Fixed;
  }

  private updateFootLocks(dt: number, motor: MotorSnapshot, turnRate: number): void {
    const c = CONFIG.ik;

    for (const foot of this.feet) {
      const wasLocked = foot.locked;
      this.refreshFootLockFromSupport(foot);
      const sourceReleased =
        foot.contactConfidence < c.contactReleaseThreshold ||
        !foot.hasGround;
      solveFootbase(
        foot.animatedHeelContact,
        foot.animatedToeContact,
        0,
        0,
        foot.footLength,
        c.footbaseAlpha,
        _animatedPivot,
      );
      _direction.copy(_animatedPivot).sub(foot.lockedTarget);
      _direction.addScaledVector(foot.lockedNormal, -_direction.dot(foot.lockedNormal));
      const lockError = _direction.length();

      if (
        foot.locked &&
        (sourceReleased ||
          foot.supportColliderHandle !== foot.lockedSupportColliderHandle ||
          lockError > c.footReleaseDistance ||
          turnRate > c.maxLockTurnRate)
      ) {
        foot.locked = false;
        foot.lockedSupportColliderHandle = null;
      } else if (
        !foot.locked &&
        foot.contactConfidence > c.contactLockThreshold &&
        foot.target.distanceTo(foot.inputTarget) <= c.footLockDistance &&
        turnRate <= c.maxLockTurnRate
      ) {
        foot.locked = true;
        foot.lockedTarget.copy(foot.inputTarget);
        foot.lockedNormal.copy(foot.probeNormal);
        foot.lockedForward.copy(foot.probeForward);
        foot.lockedSupportColliderHandle = foot.supportColliderHandle;
        this.storeFootLockInSupportSpace(foot);
      }

      const baseTarget = foot.locked ? foot.lockedTarget : foot.inputTarget;
      const baseVelocity = foot.locked ? _direction.set(0, 0, 0) : foot.inputVelocity;
      if (wasLocked !== foot.locked) {
        this.beginFootInertialization(
          foot,
          baseTarget,
          baseVelocity,
          foot.locked ? c.lockInertialization : c.unlockInertialization,
        );
      }
      if (foot.locked && foot.supportIsMoving) {
        foot.target.copy(baseTarget);
        foot.outputVelocity.copy(foot.inputVelocity);
      } else {
        this.updateFootInertialization(foot, baseTarget, baseVelocity, dt);
      }

      const desiredNormal = foot.locked ? foot.lockedNormal : foot.probeNormal;
      const desiredForward = foot.locked ? foot.lockedForward : foot.probeForward;
      if (foot.locked && foot.supportIsMoving) {
        foot.normal.copy(desiredNormal);
        foot.forward.copy(desiredForward);
      } else {
        foot.normal.lerp(desiredNormal, 1 - Math.exp(-c.footSharpness * dt)).normalize();
        foot.forward.lerp(desiredForward, 1 - Math.exp(-c.footSharpness * dt)).normalize();
      }
      foot.forward.addScaledVector(foot.normal, -foot.forward.dot(foot.normal));
      if (foot.forward.lengthSq() < 0.000001) foot.forward.copy(desiredForward);
      foot.forward.normalize();
      foot.targetHeelGround
        .copy(foot.target)
        .addScaledVector(foot.forward, -foot.footLength * foot.footbaseBalance);
      foot.targetToeGround
        .copy(foot.target)
        .addScaledVector(foot.forward, foot.footLength * (1 - foot.footbaseBalance));
      foot.heelTarget.copy(foot.targetHeelGround).addScaledVector(foot.normal, foot.heelClearance);

      foot.heelMarker.position.copy(foot.targetHeelGround);
      foot.toeMarker.position.copy(foot.targetToeGround);
      foot.footprintMarker.position.copy(foot.targetHeelGround).lerp(foot.targetToeGround, 0.5);
      _footSide.crossVectors(foot.normal, foot.forward).normalize();
      _footprintBasis.makeBasis(_footSide, foot.normal, foot.forward);
      foot.footprintMarker.quaternion.setFromRotationMatrix(_footprintBasis);

      const sprintScale = motor.speed > 6.2 ? 0.72 : 1;
      const targetWeight = foot.hasGround ? foot.contactConfidence * sprintScale : 0;
      foot.weight = damp(foot.weight, targetWeight, foot.locked ? 18 : 11, dt);
      foot.marker.position.copy(foot.target);
      foot.marker.visible = this.debugVisible && foot.hasGround;
      foot.heelMarker.visible = this.debugVisible && foot.hasGround;
      foot.toeMarker.visible = this.debugVisible && foot.hasGround;
      foot.footprintMarker.visible = this.debugVisible && foot.hasGround;
    }
  }

  private resolveFootClearance(dt: number): void {
    const c = CONFIG.ik;

    for (const foot of this.feet) {
      if (!foot.hasGround) {
        foot.clearanceLift = damp(foot.clearanceLift, 0, c.clearanceReleaseSharpness, dt);
        foot.clearanceWeight = damp(foot.clearanceWeight, 0, c.clearanceReleaseSharpness, dt);
        foot.clearanceBlocked = false;
        foot.postSolveBlocked = false;
        continue;
      }

      // A planted foot is not a swept rigid body. Solving it directly to the
      // contact plane avoids false positives where the animated-to-target path
      // crosses a stair riser even though the final leg pose is collision-free.
      // solveLegs() still validates the resulting shin, ankle, and toe segments
      // and performs one bounded lift retry when the final pose is truly blocked.
      if (foot.sourceContact || foot.locked) {
        foot.clearanceLift = 0;
        foot.clearanceWeight = 0;
        foot.clearanceBlocked = false;
        foot.postSolveBlocked = false;
        continue;
      }

      const maximumLift = this.clearanceLiftLimit(foot);
      const maximumSteps = Math.ceil(maximumLift / c.clearanceLiftStep);
      foot.clearanceLift = Math.min(foot.clearanceLift, maximumLift);
      const retainedLift = foot.supportLedge ? foot.clearanceLift : 0;
      const requiredLift = foot.postSolveBlocked
        ? Math.min(foot.clearanceLift + c.clearanceLiftStep, maximumLift)
        : retainedLift;
      const minimumStep = Math.ceil(requiredLift / c.clearanceLiftStep - 0.0001);
      let desiredLift: number = maximumLift;
      let collisionFree = false;
      for (let step = minimumStep; step <= maximumSteps; step += 1) {
        const lift = Math.min(step * c.clearanceLiftStep, maximumLift);
        _clearanceCandidate.copy(foot.heelTarget).addScaledVector(_worldUp, lift);
        if (!this.isFootClearanceBlocked(foot, _clearanceCandidate)) {
          desiredLift = lift;
          collisionFree = true;
          break;
        }
      }

      foot.clearanceLift =
        desiredLift > foot.clearanceLift
          ? desiredLift
          : damp(foot.clearanceLift, desiredLift, c.clearanceReleaseSharpness, dt);
      foot.clearanceBlocked = desiredLift > 0.001 || !collisionFree;
      foot.clearanceWeight = damp(
        foot.clearanceWeight,
        foot.clearanceBlocked
          ? foot.sourceContact || foot.weight >= c.contactLockThreshold
            ? 1
            : c.swingClearanceWeight
          : 0,
        foot.clearanceBlocked ? 30 : c.clearanceReleaseSharpness,
        dt,
      );
      if (foot.clearanceBlocked) foot.supportKind = 'blocked';
      foot.heelTarget.addScaledVector(_worldUp, foot.clearanceLift);
      foot.postSolveBlocked = false;
    }
  }

  private clearanceLiftLimit(foot: FootRuntime): number {
    return foot.sourceContact || foot.weight >= CONFIG.ik.contactLockThreshold
      ? CONFIG.ik.maxClearanceLift
      : CONFIG.ik.maxSwingClearanceLift;
  }

  private isFootClearanceBlocked(foot: FootRuntime, candidateHeel: Vector3): boolean {
    _candidateToe
      .copy(candidateHeel)
      .addScaledVector(foot.normal, foot.toeClearance - foot.heelClearance)
      .addScaledVector(foot.forward, foot.heelToBallLength);
    return (
      this.hasBlockingClearanceHit(foot.animatedHeel, candidateHeel, this.ankleClearanceShape) ||
      this.hasBlockingClearanceHit(foot.animatedKnee, candidateHeel, this.shinClearanceShape) ||
      this.hasBlockingClearanceHit(candidateHeel, _candidateToe, this.ankleClearanceShape)
    );
  }

  private hasBlockingClearanceHit(start: Vector3, end: Vector3, shape: RAPIER.Shape): boolean {
    _clearanceVelocity.copy(end).sub(start);
    if (_clearanceVelocity.lengthSq() < 0.000001) return false;
    const hit = this.world.castShape(
      start,
      IDENTITY_ROTATION,
      _clearanceVelocity,
      shape,
      CONFIG.ik.clearanceSkin,
      1,
      true,
      undefined,
      undefined,
      this.playerCollider,
    );
    return Boolean(
      hit &&
      hit.time_of_impact < 0.995 &&
      Math.abs(hit.normal1.y) < CONFIG.ik.minimumSupportNormalY
    );
  }

  private beginFootInertialization(
    foot: FootRuntime,
    baseTarget: Vector3,
    baseVelocity: Vector3,
    duration: number,
  ): void {
    foot.transitionOffset.copy(foot.target).sub(baseTarget);
    foot.transitionVelocity.copy(foot.outputVelocity).sub(baseVelocity);
    foot.transitionElapsed = 0;
    foot.transitionDuration = duration;
  }

  private updateFootInertialization(
    foot: FootRuntime,
    baseTarget: Vector3,
    baseVelocity: Vector3,
    dt: number,
  ): void {
    foot.transitionElapsed += dt;
    const coefficients = cubicDecayCoefficients(foot.transitionElapsed, foot.transitionDuration);
    foot.target
      .copy(baseTarget)
      .addScaledVector(foot.transitionOffset, coefficients.positionFromOffset)
      .addScaledVector(foot.transitionVelocity, coefficients.positionFromVelocity);
    foot.outputVelocity
      .copy(baseVelocity)
      .addScaledVector(foot.transitionOffset, coefficients.velocityFromOffset)
      .addScaledVector(foot.transitionVelocity, coefficients.velocityFromVelocity);
  }

  private solvePelvis(dt: number): void {
    const c = CONFIG.ik;
    this.pelvisConstraints.length = 0;

    for (const foot of this.feet) {
      if (!foot.hasGround || foot.contactConfidence < 0.05) continue;
      const constraint = foot.reachConstraint;
      constraint.hipY = foot.animatedHip.y;
      constraint.targetY = foot.heelTarget.y;
      constraint.horizontalDistance = Math.hypot(
        foot.heelTarget.x - foot.animatedHip.x,
        foot.heelTarget.z - foot.animatedHip.z,
      );
      constraint.preferredLength = Math.min(
        foot.geometricReach,
        foot.animatedReach + c.preferredExtensionReserve,
      );
      constraint.maximumLength = foot.geometricReach;
      constraint.priority = foot.contactConfidence + (foot.locked ? 0.35 : 0);
      this.pelvisConstraints.push(constraint);
    }

    const desiredPelvisOffset =
      solvePelvisReachOffset(this.pelvisConstraints, c.maxPelvisDrop, c.maxPelvisRise) * this.pelvisWeight;
    this.pelvisOffset = damp(this.pelvisOffset, desiredPelvisOffset, c.pelvisSharpness, dt);
    _pelvisDelta.set(0, this.pelvisOffset, 0);
    this.translateBoneWorld(this.rig.pelvis, _pelvisDelta);
    this.root.updateMatrixWorld(true);
  }

  private solveLegs(dt: number): void {
    for (const foot of this.feet) {
      const hip = foot.limb.root.getWorldPosition(_start);
      const reach = solveLimbReach(
        hip.distanceTo(foot.heelTarget),
        foot.limb.upperLength,
        foot.limb.lowerLength,
        foot.geometricReach,
        CONFIG.ik.extensionSoftness,
      );
      foot.reachability = reach.status;
      foot.extensionRatio = reach.extensionRatio;
      foot.unmetReach = reach.unmetDistance;
      foot.reachWeight = damp(
        foot.reachWeight,
        reach.status === 'reachable' ? 1 : CONFIG.ik.unreachableMinimumWeight,
        reach.status === 'reachable'
          ? CONFIG.ik.reachBlendInSharpness
          : CONFIG.ik.reachBlendOutSharpness,
        dt,
      );
      const solveWeight = Math.max(foot.weight, foot.clearanceWeight) * foot.reachWeight;
      if (solveWeight < 0.005 || !foot.hasGround) {
        foot.actualToe.copy(foot.animatedToe);
        foot.unmetReach = 0;
        foot.contactError = foot.hasGround
          ? Math.abs(
              foot.normal.dot(_direction.copy(foot.actualToe).sub(foot.groundPoint)) - foot.toeClearance,
            )
          : 0;
        continue;
      }
      this.solveLeg(foot, solveWeight);

      if (this.isSolvedFootBlocked(foot)) {
        const retryLift = Math.min(
          CONFIG.ik.clearanceLiftStep,
          this.clearanceLiftLimit(foot) - foot.clearanceLift,
        );
        if (retryLift > 0.001) {
          this.restoreFootPose(foot);
          foot.heelTarget.addScaledVector(_worldUp, retryLift);
          foot.clearanceLift += retryLift;
          foot.clearanceBlocked = true;
          foot.supportKind = 'blocked';
          this.solveLeg(foot, solveWeight);
        }
      }
      foot.postSolveBlocked = this.isSolvedFootBlocked(foot);
      if (foot.postSolveBlocked) {
        foot.clearanceBlocked = true;
        foot.supportKind = 'blocked';
      }
    }
  }

  private solveLeg(foot: FootRuntime, solveWeight: number): void {
    const c = CONFIG.ik;
    const hip = foot.limb.root.getWorldPosition(_start);
    foot.limb.root.getWorldQuaternion(_currentWorldQuaternion);
    _kneeSide.copy(foot.kneeSideLocal).applyQuaternion(_currentWorldQuaternion).normalize();
    _direction.copy(foot.heelTarget).sub(hip).normalize();
    _bendDirection.copy(_kneeSide).cross(_direction);
    if (_bendDirection.lengthSq() < 0.00001) {
      _bendDirection.copy(_worldUp).cross(_direction);
    }
    _bendDirection.normalize();
    const pole = _desiredMiddle.copy(hip).add(_bendDirection);
    const solve = this.solveTwoBone(
      foot.limb,
      foot.heelTarget,
      pole,
      solveWeight,
      foot.geometricReach,
      foot.reachableHeelTarget,
    );
    foot.unmetReach = solve.unmetDistance;
    foot.reachability = solve.status;
    foot.extensionRatio = solve.extensionRatio;
    foot.reachableToeTarget
      .copy(foot.reachableHeelTarget)
      .addScaledVector(foot.normal, foot.toeClearance - foot.heelClearance)
      .addScaledVector(foot.forward, foot.heelToBallLength);

    foot.toe.getWorldPosition(_middle);
    this.rotateBoneTowardWeighted(
      foot.limb.end,
      _middle,
      foot.reachableToeTarget,
      solveWeight,
    );
    this.alignBoneAxis(
      foot.limb.end,
      foot.localUpAxis,
      foot.normal,
      solveWeight * c.footOrientationWeight,
    );
    this.liftToeEnd(foot, solveWeight);
    foot.toe.updateWorldMatrix(true, true);
    foot.actualToe.copy(foot.toe.getWorldPosition(_middle));
    _groundPivot
      .copy(foot.targetHeelGround)
      .addScaledVector(foot.forward, foot.heelToBallLength);
    foot.contactError = Math.abs(
      foot.normal.dot(_direction.copy(foot.actualToe).sub(_groundPivot)) - foot.toeClearance,
    );
  }

  private isSolvedFootBlocked(foot: FootRuntime): boolean {
    foot.limb.middle.getWorldPosition(_actualKnee);
    foot.limb.end.getWorldPosition(_actualHeel);
    foot.toe.getWorldPosition(_middle);
    foot.toeEnd.getWorldPosition(_actualToeEnd);
    return (
      this.hasBlockingClearanceHit(_actualKnee, _actualHeel, this.shinClearanceShape) ||
      this.hasBlockingClearanceHit(_actualHeel, _middle, this.ankleClearanceShape) ||
      this.hasBlockingClearanceHit(_middle, _actualToeEnd, this.ankleClearanceShape)
    );
  }

  private liftToeEnd(foot: FootRuntime, weight: number): void {
    foot.toe.updateWorldMatrix(true, true);
    foot.toeEnd.getWorldPosition(_end);
    const height = foot.normal.dot(_direction.copy(_end).sub(foot.targetToeGround));
    if (height >= foot.toeEndClearance) return;
    _toeEndCorrection.copy(_end).addScaledVector(foot.normal, foot.toeEndClearance - height);
    this.rotateBoneTowardWeighted(foot.toe, _end, _toeEndCorrection, weight * 0.75);
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

  private solveTwoBone(
    limb: Limb,
    target: Vector3,
    pole: Vector3,
    weight: number,
    poseMaximumExtension?: number,
    reachableTarget?: Vector3,
  ): LimbReachResult {
    limb.root.updateWorldMatrix(true, true);
    limb.root.getWorldPosition(_start);
    limb.middle.getWorldPosition(_middle);
    limb.end.getWorldPosition(_end);

    const upperLength = limb.upperLength;
    const lowerLength = limb.lowerLength;
    const requestedDistance = _start.distanceTo(target);
    const reach = solveLimbReach(
      requestedDistance,
      upperLength,
      lowerLength,
      poseMaximumExtension ?? limb.maximumLength,
      CONFIG.ik.extensionSoftness,
    );
    const distance = reach.solvedDistance;
    _direction.copy(target).sub(_start).normalize();
    if (_direction.lengthSq() === 0) _direction.copy(_end).sub(_start).normalize();
    _softTarget.copy(_start).addScaledVector(_direction, distance);
    reachableTarget?.copy(_softTarget);
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
    this.rotateBoneToward(limb.middle, _end, _softTarget);

    const rootSolved = limb.root.quaternion.clone();
    const middleSolved = limb.middle.quaternion.clone();
    const solveWeight = MathUtils.clamp(weight, 0, 1);
    limb.root.quaternion.copy(rootAnimated).slerp(rootSolved, solveWeight);
    limb.root.updateWorldMatrix(true, true);
    limb.middle.quaternion.copy(middleAnimated).slerp(middleSolved, solveWeight);
    limb.middle.updateWorldMatrix(true, true);
    return reach;
  }

  private rotateBoneTowardWeighted(
    bone: Bone,
    currentEnd: Vector3,
    desiredEnd: Vector3,
    weight: number,
  ): void {
    const animated = bone.quaternion.clone();
    this.rotateBoneToward(bone, currentEnd, desiredEnd);
    const solved = bone.quaternion.clone();
    bone.quaternion.copy(animated).slerp(solved, MathUtils.clamp(weight, 0, 1));
    bone.updateWorldMatrix(true, true);
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
