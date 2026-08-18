import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const endpoint = process.argv[2] ?? 'http://127.0.0.1:9222';
const screenshotPath = process.argv[3] ?? 'runtime-ready.png';
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
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
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

const initial = structuredClone(qa);
await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 });
await new Promise((resolve) => setTimeout(resolve, 1600));
await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 });
await new Promise((resolve) => setTimeout(resolve, 300));
const afterMove = await evaluate('window.__KINETIC_GROUNDS_QA__');

await command('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
await command('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
await new Promise((resolve) => setTimeout(resolve, 140));
const afterJump = await evaluate('window.__KINETIC_GROUNDS_QA__');

await new Promise((resolve) => setTimeout(resolve, 850));
await evaluate('window.__KINETIC_GROUNDS_TELEPORT__(0, 1.05, 12.35)');
await new Promise((resolve) => setTimeout(resolve, 350));
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

const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));

const movedMeters = Math.hypot(
  afterMove.position.x - initial.position.x,
  afterMove.position.z - initial.position.z,
);
const failures = [];
if (!initial.grounded) failures.push('player did not settle on the spawn deck');
if (movedMeters < 2) failures.push(`forward movement was only ${movedMeters.toFixed(2)} m`);
if (afterJump.grounded || afterJump.position.y <= afterMove.position.y + 0.2) {
  failures.push('jump did not produce an airborne vertical displacement');
}
if (!contactSample) failures.push('contextual hand contact did not engage in the contact channel');
if (exceptions.length > 0) failures.push(`browser exceptions: ${exceptions.join('; ')}`);

console.log(
  JSON.stringify(
    {
      initial,
      afterMove,
      afterJump,
      contactSample,
      afterContactRun,
      movedMeters,
      consoleMessages,
      exceptions,
      screenshotPath,
    },
    null,
    2,
  ),
);
await command('Browser.close');
socket.close();
if (failures.length > 0) throw new Error(`Browser QA failed: ${failures.join('; ')}`);
