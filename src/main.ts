import RAPIER from '@dimforge/rapier3d-compat';
import {
  ACESFilmicToneMapping,
  CapsuleGeometry,
  CircleGeometry,
  Color,
  DirectionalLight,
  Fog,
  GridHelper,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  PCFShadowMap,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three';
import { AnimatedCharacter } from './AnimatedCharacter';
import { CharacterMotor } from './CharacterMotor';
import { CONFIG, PALETTE } from './config';
import { Course } from './Course';
import { InputController, type InputFrame } from './InputController';
import { formatState } from './math';
import { ThirdPersonCamera } from './ThirdPersonCamera';
import './styles.css';

interface QaSnapshot {
  ready: boolean;
  state: string;
  grounded: boolean;
  speed: number;
  position: { x: number; y: number; z: number };
  contacts: string;
  draws: number;
  triangles: number;
  handDebug: AnimatedCharacter['handDebug'];
  footDebug: AnimatedCharacter['footDebug'];
}

const qaWindow = window as Window & {
  __KINETIC_GROUNDS_QA__?: QaSnapshot;
  __KINETIC_GROUNDS_TELEPORT__?: (x: number, y: number, z: number) => void;
};

function element<T extends HTMLElement>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error(`Required interface element not found: ${selector}`);
  return value;
}

const canvas = element<HTMLCanvasElement>('#world');
const loading = element<HTMLDivElement>('#loading');
const loadingBar = element<HTMLSpanElement>('#loading-bar');
const loadingLabel = element<HTMLParagraphElement>('#loading-label');
const fatal = element<HTMLDivElement>('#fatal');
const capture = element<HTMLButtonElement>('#capture');
const stateLabel = element<HTMLElement>('#state');
const speedLabel = element<HTMLElement>('#speed');
const surfaceLabel = element<HTMLElement>('#surface');
const debugPanel = element<HTMLPreElement>('#debug');
const routeItems = [...document.querySelectorAll<HTMLElement>('.route-card li')];

function setLoading(label: string, amount: number): void {
  loadingLabel.textContent = label;
  loadingBar.style.width = `${Math.round(amount * 100)}%`;
}

async function bootstrap(): Promise<void> {
  setLoading('INITIALIZING PHYSICS', 0.06);
  await RAPIER.init();

  const renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, CONFIG.quality.maxPixelRatio));

  const scene = new Scene();
  scene.background = new Color(PALETTE.sky);
  scene.fog = new Fog(PALETTE.fog, 34, 88);
  const camera = new PerspectiveCamera(CONFIG.camera.fov, 1, 0.05, 180);

  const hemisphere = new HemisphereLight(0xe7f1ee, 0x343c3d, 2.1);
  scene.add(hemisphere);
  const sun = new DirectionalLight(0xfff1d7, 3.3);
  sun.position.set(-18, 28, -14);
  sun.castShadow = true;
  sun.shadow.mapSize.set(CONFIG.quality.shadowMapSize, CONFIG.quality.shadowMapSize);
  sun.shadow.camera.left = -34;
  sun.shadow.camera.right = 34;
  sun.shadow.camera.top = 38;
  sun.shadow.camera.bottom = -24;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 90;
  sun.shadow.bias = -0.00014;
  sun.shadow.normalBias = 0.018;
  scene.add(sun);

  const underlay = new Mesh(
    new CircleGeometry(78, 32),
    new MeshBasicMaterial({ color: PALETTE.ink, fog: true }),
  );
  underlay.rotation.x = -Math.PI / 2;
  underlay.position.y = -5;
  scene.add(underlay);
  const grid = new GridHelper(150, 100, 0x343f41, 0x222b2d);
  grid.position.y = -4.97;
  scene.add(grid);

  const world = new RAPIER.World({ x: 0, y: -CONFIG.motor.gravity, z: 0 });
  const course = new Course(scene, world);
  const motor = new CharacterMotor(world, course.spawn);
  const cameraRig = new ThirdPersonCamera(camera);

  const input = new InputController(canvas, (locked) => {
    document.body.classList.toggle('is-captured', locked);
    capture.querySelector('strong')!.textContent = locked ? 'SIMULATION ACTIVE' : 'ENTER SIMULATION';
    capture.querySelector('small')!.textContent = locked ? 'ESC TO RELEASE MOUSE' : 'CLICK TO CAPTURE MOUSE';
  });
  capture.addEventListener('click', () => input.requestCapture());
  canvas.addEventListener('click', () => {
    if (!input.locked) input.requestCapture();
  });

  const capsuleDebug = new Mesh(
    new CapsuleGeometry(
      CONFIG.motor.capsuleRadius,
      CONFIG.motor.capsuleHalfHeight * 2,
      6,
      10,
    ),
    new MeshBasicMaterial({ color: PALETTE.acid, wireframe: true, depthTest: false }),
  );
  capsuleDebug.renderOrder = 15;
  capsuleDebug.visible = false;
  scene.add(capsuleDebug);

  const character = await AnimatedCharacter.load(
    scene,
    world,
    motor.collider,
    course,
    setLoading,
  );
  setLoading('SYNCING GAIT + CONTACT SOLVERS', 0.94);
  let snapshot = motor.snapshot();
  character.update(1 / CONFIG.simulationHz, snapshot);
  cameraRig.reset(snapshot, world, motor.collider);

  const resize = (): void => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, CONFIG.quality.maxPixelRatio));
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(height, 1);
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);
  resize();

  setLoading('READY', 1);
  await new Promise((resolve) => window.setTimeout(resolve, 280));
  loading.classList.add('is-hidden');

  const fixedDt = 1 / CONFIG.simulationHz;
  let previousTime = performance.now() / 1000;
  let accumulator = 0;
  let jumpQueued = false;
  let debugVisible = false;
  let smoothedFps = 60;
  let hudTimer = 0;

  if (import.meta.env.DEV) {
    qaWindow.__KINETIC_GROUNDS_TELEPORT__ = (x: number, y: number, z: number): void => {
      motor.reset(course.spawn.clone().set(x, y, z));
      snapshot = motor.snapshot();
      character.resetIK(snapshot);
      cameraRig.reset(snapshot, world, motor.collider);
    };
  }

  const updateHud = (): void => {
    stateLabel.textContent = formatState(snapshot.state);
    speedLabel.textContent = snapshot.speed.toFixed(1);
    surfaceLabel.textContent = character.contactSummary;
    const routeIndex =
      snapshot.position.z < 0
        ? 0
        : snapshot.position.z < 11
          ? 1
          : Math.abs(snapshot.position.x) < 3.4 && snapshot.position.z < 22
            ? 2
            : 3;
    routeItems.forEach((item, index) => item.classList.toggle('active', index === routeIndex));
    if (debugVisible) {
      debugPanel.textContent = [
        `FPS       ${smoothedFps.toFixed(0)}`,
        `STATE     ${formatState(snapshot.state)}`,
        `SPEED     ${snapshot.speed.toFixed(2)} m/s`,
        `VERTICAL  ${snapshot.velocity.y.toFixed(2)} m/s`,
        `GROUNDED  ${snapshot.grounded ? 'YES' : 'NO'}`,
        `POSITION  ${snapshot.position.x.toFixed(1)} / ${snapshot.position.y.toFixed(1)} / ${snapshot.position.z.toFixed(1)}`,
        character.debugSummary,
        `DRAWS     ${renderer.info.render.calls}`,
        `TRIS      ${renderer.info.render.triangles.toLocaleString()}`,
      ].join('\n');
    }
  };

  const frame = (timeMs: number): void => {
    const now = timeMs / 1000;
    const frameDt = Math.min(0.05, Math.max(0, now - previousTime));
    previousTime = now;
    accumulator = Math.min(accumulator + frameDt, fixedDt * 4);
    smoothedFps += ((frameDt > 0 ? 1 / frameDt : 60) - smoothedFps) * 0.06;

    const inputFrame = input.sample();
    jumpQueued ||= inputFrame.jumpPressed;
    if (inputFrame.debugPressed) {
      debugVisible = !debugVisible;
      debugPanel.hidden = !debugVisible;
      capsuleDebug.visible = debugVisible;
      character.setDebugVisible(debugVisible);
    }
    if (inputFrame.resetPressed) {
      motor.reset(course.spawn);
      snapshot = motor.snapshot();
      character.resetIK(snapshot);
      cameraRig.reset(snapshot, world, motor.collider);
    }

    cameraRig.applyInput(input.consumeLook(), input.consumeWheel());
    let firstStep = true;
    while (accumulator >= fixedDt) {
      const simulationInput: InputFrame = {
        ...inputFrame,
        move: inputFrame.move,
        jumpPressed: firstStep && jumpQueued,
        resetPressed: false,
        debugPressed: false,
      };
      snapshot = motor.simulate(fixedDt, simulationInput, cameraRig.yaw);
      if (firstStep && jumpQueued) jumpQueued = false;
      firstStep = false;
      accumulator -= fixedDt;
    }

    if (
      snapshot.position.y < -4.2 ||
      Math.abs(snapshot.position.x) > 62 ||
      Math.abs(snapshot.position.z) > 62
    ) {
      motor.reset(course.spawn);
      snapshot = motor.snapshot();
      character.resetIK(snapshot);
      cameraRig.reset(snapshot, world, motor.collider);
    }

    character.update(frameDt, snapshot);
    cameraRig.update(frameDt, snapshot, world, motor.collider);
    capsuleDebug.position.copy(snapshot.position);
    renderer.render(scene, camera);
    qaWindow.__KINETIC_GROUNDS_QA__ = {
      ready: true,
      state: snapshot.state,
      grounded: snapshot.grounded,
      speed: snapshot.speed,
      position: {
        x: snapshot.position.x,
        y: snapshot.position.y,
        z: snapshot.position.z,
      },
      contacts: character.contactSummary,
      draws: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      handDebug: character.handDebug,
      footDebug: character.footDebug,
    };

    hudTimer += frameDt;
    if (hudTimer > 0.08) {
      updateHud();
      hudTimer = 0;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  loading.classList.add('is-hidden');
  fatal.hidden = false;
  fatal.innerHTML = `<strong>SIMULATION FAILED TO LOAD</strong><span>${message}</span>`;
  qaWindow.__KINETIC_GROUNDS_QA__ = {
    ready: false,
    state: `ERROR: ${message}`,
    grounded: false,
    speed: 0,
    position: { x: 0, y: 0, z: 0 },
    contacts: 'ERROR',
    draws: 0,
    triangles: 0,
    handDebug: [],
    footDebug: [],
  };
  console.error(error);
});
