import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const endpoint = process.argv[2] ?? 'http://127.0.0.1:9222';
const screenshotPath = process.argv[3] ?? 'runtime-ready.png';
const edgeScreenshotPath = screenshotPath.replace(/\.png$/i, '-edge.png');
const terrainScreenshotPath = screenshotPath.replace(/\.png$/i, '-terrain.png');
const shouldLaunchChrome = process.argv.includes('--launch');
const timeoutAt = Date.now() + 45_000;

if (shouldLaunchChrome) {
  const port = new URL(endpoint).port || '9222';
  const chromePath =
    process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  spawn(
    chromePath,
    [
      '--headless=new',
      '--no-first-run',
      '--disable-extensions',
      '--disable-background-networking',
      '--enable-unsafe-swiftshader',
      '--use-angle=swiftshader',
      '--window-size=1440,900',
      '--hide-scrollbars',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${process.env.TEMP ?? '.'}\\kinetic-grounds-cdp-${port}`,
      'http://127.0.0.1:4173/',
    ],
    { detached: false, stdio: 'ignore' },
  ).unref();
}

let target;
while (!target && Date.now() < timeoutAt) {
  try {
    const targets = await fetch(`${endpoint}/json`).then((response) => response.json());
    target = targets.find((candidate) => candidate.type === 'page' && candidate.url.includes('127.0.0.1:4173'));
  } catch {
    // Chrome may still be starting.
  }
  if (!target) await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!target) throw new Error('Chrome DevTools target did not become available.');

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let nextId = 1;
const pending = new Map();
const consoleMessages = [];
const exceptions = [];

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  }
  if (message.method === 'Runtime.consoleAPICalled') {
    consoleMessages.push(
      `${message.params.type}: ${message.params.args.map((arg) => arg.value ?? arg.description).join(' ')}`,
    );
  }
  if (message.method === 'Runtime.exceptionThrown') {
    exceptions.push(message.params.exceptionDetails.text);
  }
});

function command(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) {
    const description = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    throw new Error(`${result.exceptionDetails.text}: ${description}`);
  }
  return result.result.value;
}

async function toggleDebug() {
  await command('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: '`',
    code: 'Backquote',
    windowsVirtualKeyCode: 192,
  });
  await command('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: '`',
    code: 'Backquote',
    windowsVirtualKeyCode: 192,
  });
}

await command('Runtime.enable');
await command('Page.enable');

let qa;
while (Date.now() < timeoutAt) {
  qa = await evaluate('window.__KINETIC_GROUNDS_QA__ ?? null');
  if ((qa?.ready && qa?.grounded) || qa?.state?.startsWith('ERROR:')) break;
  await new Promise((resolve) => setTimeout(resolve, 300));
}
if (!qa?.ready) {
  throw new Error(`Application did not become ready. QA state: ${JSON.stringify(qa)}; exceptions: ${exceptions.join('; ')}`);
}

await new Promise((resolve) => setTimeout(resolve, 250));
qa = await evaluate('window.__KINETIC_GROUNDS_QA__');

const initial = structuredClone(qa);
await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 });
let locomotionLockObserved = false;
const locomotionToeSpeedRange = [
  { minimum: Number.POSITIVE_INFINITY, maximum: 0 },
  { minimum: Number.POSITIVE_INFINITY, maximum: 0 },
];
for (let sampleIndex = 0; sampleIndex < 20; sampleIndex += 1) {
  await new Promise((resolve) => setTimeout(resolve, 80));
  const locomotionSample = await evaluate('window.__KINETIC_GROUNDS_QA__');
  locomotionLockObserved ||=
    locomotionSample.speed > 1.5 && locomotionSample.footDebug?.some((foot) => foot.locked);
  locomotionSample.footDebug?.forEach((foot, footIndex) => {
    const range = locomotionToeSpeedRange[footIndex];
    range.minimum = Math.min(range.minimum, foot.toeSpeed);
    range.maximum = Math.max(range.maximum, foot.toeSpeed);
  });
}
await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 });
await new Promise((resolve) => setTimeout(resolve, 300));
const afterMove = await evaluate('window.__KINETIC_GROUNDS_QA__');

await command('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
await new Promise((resolve) => setTimeout(resolve, 80));
await command('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
let afterJump = await evaluate('window.__KINETIC_GROUNDS_QA__');
const jumpDeadline = Date.now() + 700;
while (afterJump.grounded && Date.now() < jumpDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 40));
  afterJump = await evaluate('window.__KINETIC_GROUNDS_QA__');
}

await new Promise((resolve) => setTimeout(resolve, 850));
await evaluate('window.__KINETIC_GROUNDS_TELEPORT__(0, 1.05, 12.35)');
await new Promise((resolve) => setTimeout(resolve, 350));
const afterTeleport = await evaluate('window.__KINETIC_GROUNDS_QA__');
await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 });
let contactSample = null;
const contactDeadline = Date.now() + 3_500;
while (Date.now() < contactDeadline) {
  const sample = await evaluate('window.__KINETIC_GROUNDS_QA__');
  if (sample.contacts.includes('HAND CONTACT') || sample.contacts.includes('DUAL CONTACT')) {
    contactSample = sample;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 120));
}
const afterContactRun = await evaluate('window.__KINETIC_GROUNDS_QA__');
await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 });
await new Promise((resolve) => setTimeout(resolve, 100));

// Straddle the edge of the tallest terrain tile: one foot is 0.52 m above the other.
await evaluate('window.__KINETIC_GROUNDS_TELEPORT__(9.86, 1.58, 2.7)');
await new Promise((resolve) => setTimeout(resolve, 2_000));
const unevenTerrainSample = await evaluate('window.__KINETIC_GROUNDS_QA__');
await toggleDebug();
await new Promise((resolve) => setTimeout(resolve, 120));
const terrainScreenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
writeFileSync(terrainScreenshotPath, Buffer.from(terrainScreenshot.data, 'base64'));
await toggleDebug();

// Straddle two calibration treads so the sole probes disagree across a 0.20 m riser.
await evaluate('window.__KINETIC_GROUNDS_TELEPORT__(0, 1.9, 1.72)');
await new Promise((resolve) => setTimeout(resolve, 2_000));
const stairEdgeSample = await evaluate('window.__KINETIC_GROUNDS_QA__');
await toggleDebug();
await new Promise((resolve) => setTimeout(resolve, 120));
const edgeScreenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
writeFileSync(edgeScreenshotPath, Buffer.from(edgeScreenshot.data, 'base64'));
await toggleDebug();

// Move far enough across the edge that the trailing sole loses upper-tread
// ownership and must settle on the adjacent lower tread.
await evaluate('window.__KINETIC_GROUNDS_TELEPORT__(0, 1.9, 1.58)');
await new Promise((resolve) => setTimeout(resolve, 2_000));
const stairSplitSample = await evaluate('window.__KINETIC_GROUNDS_QA__');

// Stand on the kinematic platform long enough to verify both controller carry
// and collider-local foot locks.
const platformFixture = stairSplitSample.platforms?.[0];
if (platformFixture) {
  await evaluate(
    `window.__KINETIC_GROUNDS_TELEPORT__(${platformFixture.position.x}, ${platformFixture.top + 0.9}, ${platformFixture.position.z})`,
  );
}
await new Promise((resolve) => setTimeout(resolve, 700));
const platformStartSample = await evaluate('window.__KINETIC_GROUNDS_QA__');
await new Promise((resolve) => setTimeout(resolve, 1_300));
const platformEndSample = await evaluate('window.__KINETIC_GROUNDS_QA__');

const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));

const movedMeters = Math.hypot(
  afterMove.position.x - initial.position.x,
  afterMove.position.z - initial.position.z,
);
const failures = [];
if (!initial.grounded) failures.push('player did not settle on the spawn deck');
if (!initial.footDebug?.every((foot) => foot.hasGround && foot.footprintSupported)) {
  failures.push('footbase support did not initialize at rest');
}
if (initial.footDebug?.some((foot) => Math.abs(foot.target.y) > 0.01)) {
  failures.push('a response-deck footbase target inherited capsule clearance instead of the ground plane');
}
if (!locomotionLockObserved) failures.push('footbase locking did not engage during locomotion');
if (movedMeters < 1.8) failures.push(`forward movement was only ${movedMeters.toFixed(2)} m`);
if (afterJump.grounded || afterJump.position.y <= afterMove.position.y + 0.2) {
  failures.push('jump did not produce an airborne vertical displacement');
}
if (!contactSample) failures.push('contextual hand contact did not engage in the contact channel');
if (!unevenTerrainSample.grounded) failures.push('player did not settle on the uneven-terrain fixture');
if (unevenTerrainSample.footDebug?.some((foot) => !foot.hasGround || !foot.sourceContact)) {
  failures.push('both source contacts were not preserved across the split-height terrain');
}
if (unevenTerrainSample.footDebug?.some((foot) => foot.weight < 0.7)) {
  failures.push('both feet did not receive full stance correction on split-height terrain');
}
if (unevenTerrainSample.footDebug?.some((foot) => foot.contactError > 0.03)) {
  failures.push('a toe remained more than 3 cm from its split-height ground plane');
}
if (
  unevenTerrainSample.footDebug?.some(
    (foot) => foot.contactError > 0.02 && foot.reachability === 'reachable',
  )
) {
  failures.push('split-height contact error was not explained by anatomical reachability');
}
if (!stairEdgeSample.grounded) failures.push('player did not settle on the stair-edge fixture');
if (!stairEdgeSample.footDebug?.some((foot) => foot.supportKind === 'ledge' || foot.clearanceBlocked)) {
  failures.push('stair-edge fixture did not exercise ledge classification or clearance correction');
}
if (stairEdgeSample.footDebug?.some((foot) => foot.postSolveBlocked)) {
  failures.push('a solved shin, ankle, or foot segment still intersected the stair riser');
}
if (stairEdgeSample.footDebug?.some((foot) => foot.contactError > 0.012)) {
  failures.push('a planted ledge foot separated from its ground-contact markers');
}
if (
  stairEdgeSample.footDebug?.some(
    (foot) => foot.sourceContact && foot.clearanceLift > 0.005 && !foot.postSolveBlocked,
  )
) {
  failures.push('a collision-free planted foot retained unnecessary clearance lift');
}
if (stairSplitSample.footDebug?.some((foot) => !foot.hasGround || foot.contactError > 0.06)) {
  failures.push('a foot did not settle cleanly after releasing the upper stair tread');
}
const stairToeHeights = stairSplitSample.footDebug?.map((foot) => foot.actualToe.y) ?? [];
if (stairToeHeights.length !== 2 || Math.abs(stairToeHeights[0] - stairToeHeights[1]) < 0.14) {
  failures.push('stair release did not place the feet on separate tread heights');
}
if (stairSplitSample.footDebug?.some((foot) => foot.postSolveBlocked)) {
  failures.push('stair release left a solved segment intersecting the riser');
}
if (!platformFixture) failures.push('moving-platform fixture was not published to QA');
if (!platformEndSample.footDebug?.some((foot) => foot.supportIsMoving && foot.locked)) {
  failures.push('footbase locks did not stay relative to the moving platform');
}
const platformCarry = Math.hypot(
  platformEndSample.position.x - platformStartSample.position.x,
  platformEndSample.position.z - platformStartSample.position.z,
);
if (platformCarry < 0.08) failures.push('character controller did not inherit moving-platform displacement');
if (
  afterTeleport.footDebug?.some(
    (foot) =>
      Math.abs(foot.target.x - afterTeleport.position.x) > 2 ||
      Math.abs(foot.target.z - afterTeleport.position.z) > 2,
  )
) {
  failures.push('a foot lock retained its pre-teleport world-space target');
}
if (exceptions.length > 0) failures.push(`browser exceptions: ${exceptions.join('; ')}`);

console.log(
  JSON.stringify(
    {
      initial,
      afterMove,
      afterJump,
      afterTeleport,
      contactSample,
      afterContactRun,
      unevenTerrainSample,
      stairEdgeSample,
      stairSplitSample,
      platformStartSample,
      platformEndSample,
      platformCarry,
      movedMeters,
      locomotionLockObserved,
      locomotionToeSpeedRange,
      consoleMessages,
      exceptions,
      screenshotPath,
      edgeScreenshotPath,
      terrainScreenshotPath,
    },
    null,
    2,
  ),
);
await command('Browser.close');
socket.close();
if (failures.length > 0) throw new Error(`Browser QA failed: ${failures.join('; ')}`);
