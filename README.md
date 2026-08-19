# Kinetic Grounds

Kinetic Grounds is a browser-based third-person locomotion and inverse-kinematics showcase built with Three.js, TypeScript, and Rapier. It uses an authored, skinned humanoid model and motion library inside a compact abstract course designed to exercise acceleration, slopes, stairs, uneven footing, jumping, landing, camera collision, and contextual hand contacts.

![Kinetic Grounds gameplay showing the player inside the hand-contact channel](docs/kinetic-grounds-gameplay.png)

## Current feature set

- Camera-relative walking, jogging, sprinting, turning, jumping, falling, and landing.
- Fixed-step kinematic capsule controller with acceleration, braking, gravity, slope limits, autostep, ground snapping, coyote time, and jump buffering.
- Authored Quaternius humanoid model with idle, walk, jog, sprint, jump-start, airborne, and landing animations.
- Collision-aware terrain IK with an immutable animation-input pose, measured heel-to-toe footbases, five-point plus foot-shaped support queries, ledge ownership, velocity-filtered contacts, platform-relative inertialized locks, bounded pelvis compensation, complete reachability handling, and slope-aware foot roll.
- Contextual hand IK on tagged walls and waist-height contact surfaces. The solver derives each arm's outward direction from the animated shoulder, so it does not assume a particular rig handedness.
- Damped third-person camera with mouse orbit, zoom, velocity-aware targeting, pitch limits, and sphere-cast obstruction avoidance.
- Deterministic low-poly test course covering shallow and rejected slopes, varied stairs, uneven tiles, a moving platform, landings, a contact corridor, jump gaps, and fall recovery.
- Loading screen, compact telemetry HUD, route indicator, pointer-lock prompt, fullscreen toggle, and optional physics/IK diagnostics.
- Offline runtime assets: the application does not fetch models, animation clips, textures, or scripts from third-party services after installation.

## Technology

| Layer | Implementation |
| --- | --- |
| Rendering | Three.js `WebGLRenderer`, authored GLB assets, directional shadows, fog, ACES tone mapping |
| Physics | `@dimforge/rapier3d-compat` with a position-based kinematic capsule |
| Animation | Three.js `AnimationMixer` and semantic clip state machine |
| IK | Footbase contact pipeline and custom analytic two-bone limb solver applied as joint overrides over a snapshotted animation pose |
| Application | Vanilla TypeScript, HTML, and CSS |
| Tooling | Vite, TypeScript project references, Vitest |

## Requirements and setup

- Node.js 22.12+ or 20.19+
- A current desktop browser with WebGL2 and Pointer Lock support
- Keyboard and mouse

Install and start the development server:

```powershell
npm.cmd install
npm.cmd run dev
```

Open the URL printed by Vite, then click **Enter Simulation** to capture the mouse.

For a production build:

```powershell
npm.cmd run build
npm.cmd run preview
```

The production output is written to `dist/` and can be hosted as a static site.

## Controls

| Input | Action |
| --- | --- |
| `W`, `A`, `S`, `D` | Move relative to the camera |
| `Ctrl` | Walk while held |
| `Shift` | Sprint while held |
| `Space` | Jump |
| Mouse | Orbit camera while pointer is captured |
| Mouse wheel | Change follow distance |
| `R` | Reset to the response deck |
| `F` | Toggle browser fullscreen on or off |
| Backquote | Toggle collider, IK target, state, and render diagnostics |
| `Esc` | Release pointer lock; the browser also uses it to leave fullscreen |

## Runtime architecture

The application is assembled in `src/main.ts`. Startup initializes Rapier, the renderer, lighting, course colliders, motor, camera, input, authored character, animation clips, HUD, and debug visualization. Asset failures are reported in the interface instead of substituting a procedural player.

The live frame flow is:

```text
Keyboard + mouse
      |
      v
InputController --> CharacterMotor --> Rapier collision correction
                           |                     |
                           v                     v
                    MotorSnapshot ------> ThirdPersonCamera
                           |
                           v
                 AnimationMixer base pose
                            |
                            v
               Immutable active-bone pose snapshot
                            |
                            v
      Footprint + point probes + inertialized footbase locks
       Ledge classification + complete reachability bounds
              Pelvis + limb + foot-roll orientation
                         Hand IK
                           |
                           v
                     Three.js render
```

Physics uses a 60 Hz accumulator. Each fixed step advances kinematic course surfaces, carries a grounded controller by its support displacement, asks Rapier to correct the desired capsule translation, advances the world, and publishes a `MotorSnapshot`. Animation, IK, camera damping, HUD updates, and rendering use the latest snapshot once per display frame.

### Character motor

`src/CharacterMotor.ts` owns the player rigid body, capsule collider, Rapier character controller, and locomotion state. Movement input is converted from camera space to world space, including the camera's screen-right convention for `A` and `D`. Horizontal velocity approaches gait-specific targets with separate acceleration, braking, and air-control rates.

The motor currently provides:

- 2.0 m/s walk, 4.5 m/s jog, and 7.5 m/s sprint targets.
- 6.25 m/s jump impulse and 18 m/s² gameplay gravity.
- 120 ms coyote time and 140 ms jump buffering.
- 0.35 m autostep, 0.30 m ground snap, 48° maximum climb slope, and automatic sliding above 52°.
- Soft and hard landing states selected from downward impact speed.
- Automatic reset when the player falls below the course or leaves its safety bounds.

### Animation system

`src/AnimatedCharacter.ts` loads the authored player from `night-striker.glb` and the no-root-motion library from `universal-animation-library.glb`. Both assets share the same named humanoid hierarchy, so clips bind directly to the visible rig.

The semantic states are `idle`, `walk`, `jog`, `sprint`, `jumpStart`, `airborne`, `land`, and `hardLand`. Crossfades smooth state changes, while locomotion clip playback rates are bounded around the current physics speed. Physics always owns translation; animation never moves the collision capsule through root motion.

### Foot IK

Foot IK runs as a weighted joint-override stack after every `AnimationMixer` update. Previous overrides are cleared before sampling, and the fresh active-bone pose is snapshotted so an IK result never becomes a later frame's input:

1. A root trace establishes the local reference height. Five point probes and a thin, rig-sized Rapier footprint sweep cover the animated heel, toe, toe end, and sole edges while excluding the player capsule and non-IK surfaces.
2. Probe hits are grouped by collider and compared by height. A planted or upper surface retains ownership while it has meaningful coverage; the footprint bridges narrow cracks that a ray can fall through.
3. The measured heel and toe contacts form a ground-parallel footbase. A height-derived balance selects the lower contact as the dominant pivot, which is projected directly onto the support plane so controller skin clearance cannot lift the visible feet.
4. Full three-dimensional toe velocity and height relative to the authored root generate a five-frame source-contact vote. Separate acquisition and release thresholds lock the footbase, while cubic inertialization preserves position and velocity continuity.
5. Locks are stored in the supporting collider's local space. Static locks remain world-stable; moving-platform locks follow translation and rotation without a smoothing filter fighting the surface.
6. Rapier sphere sweeps validate the ankle path, shin, and foot. Bounded 18 cm stance and 10 cm swing budgets prevent obstacle clearance from producing an extreme high-knee pose.
7. A confidence-weighted pelvis interval pass prefers the animated bend, uses a capped 58 cm correction, and assigns impossible residual error to the less reliable contact.
8. The analytic solver uses cached limb lengths and animated bend axes. It distinguishes reachable, too-far, and too-close targets, softens extension near the singularity, and blends an unreachable leg toward the authored pose.
9. Ordered ankle and toe passes reconstruct targets from the footbase, align both forward and up axes to the support plane, and rotate around the lower heel/toe contact.
10. A post-solve penetration check covers shin, ankle, foot, and toe. One bounded retry starts from the immutable sampled pose rather than the first solve's output.
11. Locks release on contact loss, support loss, excessive separation, airborne state, or high turn rate. `resetIK()` clears temporal and collider-local state on reset and teleport.

### Hand IK

Course colliders opt into hand contact through surface metadata. While grounded and moving, each shoulder probes outward toward eligible colliders. A valid contact produces a smoothed palm target, elbow pole, and surface-normal orientation. IK blends down at sprint speed and releases cleanly when the wall leaves reach.

Hand contacts are an animation enhancement only. The current implementation does not include grabbing, climbing, mantling, or vaulting.

### Camera

`src/ThirdPersonCamera.ts` maintains yaw, pitch, and follow distance independently from the character heading. It damps both the target and camera position, offsets framing slightly with velocity, and sphere-casts from the target toward the desired camera position. A hit shortens the spring arm before rendering, preventing most wall and terrain clipping.

### Course and presentation

`src/Course.ts` creates visual meshes and matching Rapier colliders from the same deterministic descriptors. The zones are:

1. **Response deck** - spawn, acceleration, braking, and turning.
2. **Grade and step calibration** - shallow ramp, varied risers, stairs, summit, descent, and uneven tiles.
3. **Contact channel** - tagged orange walls for contextual hand IK.
4. **Air control** - runway, separated landing pads, drops, and recovery.
5. **Moving support** - a kinematic platform used to validate controller carry and collider-local foot locks.
6. **Slope rejection** - a 58° ramp that exceeds the controller's climb limit.

The renderer uses a capped device pixel ratio, directional shadows, hemisphere lighting, fog, flat-shaded course materials, and an abstract high-contrast palette. The current captured scene renders roughly 31,000 triangles and 130 draw calls, depending on camera visibility.

## Configuration

All primary tuning values live in `src/config.ts`:

| Group | Examples |
| --- | --- |
| Simulation | Fixed update frequency and spawn position |
| Motor | Capsule size, gait speeds, acceleration, gravity, jump timing, slopes, autostep |
| Camera | FOV, pitch, distance, sensitivity, damping, collision radius |
| IK | Sole dimensions, support discontinuity thresholds, clearance proxy radii/lift, contact voting, lock hysteresis, inertialization, soft reach, pelvis weighting, orientation, and hand reach |
| Quality | Maximum pixel ratio and shadow-map resolution |

Course geometry and contact tags are authored in `src/Course.ts`. Animation-to-state mapping and required bone names are defined in `src/AnimatedCharacter.ts`.

## Project layout

```text
public/assets/quaternius/    Bundled character, animations, and CC0 license files
scripts/qa-browser.mjs      Chrome DevTools integration and screenshot harness
src/AnimatedCharacter.ts    Asset loading, animation state machine, hand and foot IK
src/CharacterMotor.ts       Rapier controller and locomotion state
src/Course.ts               Visual course, fixed colliders, and kinematic platform
src/InputController.ts      Keyboard, pointer lock, mouse orbit, and fullscreen input
src/ThirdPersonCamera.ts    Follow camera and obstruction avoidance
src/config.ts               Central tuning values
src/ik.ts                   Footbase, reachability, contact, pelvis, and inertialization math
src/main.ts                 Bootstrap, fixed-step loop, HUD, debug and recovery
src/styles.css              Loading screen, HUD, telemetry, prompts and responsive layout
```

## Testing and validation

Run the complete static and unit validation:

```powershell
npm.cmd run check
```

The current suite contains twenty-one tests covering:

- Angle wrapping, damping, easing, and planar velocity math.
- Ground settling, camera-forward acceleration, jumping, correct `A`/`D` orientation, and inherited moving-platform displacement.
- GLB signatures, authored mesh/skin presence, required humanoid bones, and semantic locomotion clips.
- IK footbase pivot selection, both reachability bounds, soft-extension continuity, cubic position/velocity decay, contact-flicker rejection, source-contact classification, reach-aware pelvis bounds, meaningful ledge ownership, single-sample tread release, sole-coverage selection, and coplanar-surface continuity.

Build validation is separate:

```powershell
npm.cmd run build
```

`scripts/qa-browser.mjs` drives a real headless Chrome session through the DevTools protocol. It verifies footprint support, moving footbase locks, forward movement, jumping, teleport-safe reset, contextual hand IK, anatomically bounded behavior across a 0.52 m terrain split, collision-free stair-edge ownership, clean release onto separate tread heights, controller carry on a moving platform, and platform-relative foot locks. It also records render statistics and browser exceptions and writes the gameplay screenshot used above.

Run Vite on the harness's expected port, then launch Chrome with a DevTools endpoint on port 9223:

```powershell
npm.cmd run dev -- --port 4173
node scripts/qa-browser.mjs http://127.0.0.1:9223 docs/kinetic-grounds-gameplay.png --launch
```

Set `CHROME_PATH` if Chrome is not installed at its standard Windows location.

## Assets and licensing

The visible player is always an authored and rigged 3D model; there is no procedural visual fallback. The bundled Universal Base Character and Universal Animation Library are CC0 assets by Quaternius. Runtime copies, upstream sources, conversion history, creator credits, and licenses are documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and beside the assets in `public/assets/quaternius/`.

## Current scope

This is a focused desktop locomotion vertical slice. It does not currently include touch controls, gamepad support, combat, climbing, vaulting, multiplayer, persistence, audio, or a backend. The course is deterministic, and the project targets current evergreen desktop browsers rather than legacy WebGL implementations.
