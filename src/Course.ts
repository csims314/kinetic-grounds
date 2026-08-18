import RAPIER from '@dimforge/rapier3d-compat';
import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  EdgesGeometry,
  Euler,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Scene,
  TorusGeometry,
  Vector3,
} from 'three';
import { PALETTE } from './config';

export type SurfaceKind = 'ground' | 'step' | 'ramp' | 'contact' | 'landing';

export interface SurfaceMetadata {
  kind: SurfaceKind;
  handContact: boolean;
  name: string;
}

interface BoxDescriptor {
  name: string;
  position: [number, number, number];
  size: [number, number, number];
  rotation?: [number, number, number];
  color?: number;
  surface?: SurfaceKind;
  handContact?: boolean;
  collider?: boolean;
  edges?: boolean;
}

const materialCache = new Map<number, MeshStandardMaterial>();

function material(color: number): MeshStandardMaterial {
  let value = materialCache.get(color);
  if (!value) {
    value = new MeshStandardMaterial({
      color,
      roughness: 0.82,
      metalness: 0.02,
      flatShading: true,
    });
    materialCache.set(color, value);
  }
  return value;
}

export class Course {
  readonly group = new Group();
  readonly surfaces = new Map<number, SurfaceMetadata>();
  readonly handContactHandles = new Set<number>();
  readonly spawn = new Vector3(0, 1.05, -16);

  constructor(scene: Scene, readonly world: RAPIER.World) {
    this.group.name = 'Abstract locomotion course';
    scene.add(this.group);
    this.build();
  }

  isHandContact(collider: RAPIER.Collider): boolean {
    return this.handContactHandles.has(collider.handle);
  }

  surfaceFor(collider: RAPIER.Collider | null): SurfaceMetadata | undefined {
    return collider ? this.surfaces.get(collider.handle) : undefined;
  }

  private addBox(descriptor: BoxDescriptor): Mesh {
    const { name, position, size } = descriptor;
    const rotation = descriptor.rotation ?? [0, 0, 0];
    const color = descriptor.color ?? PALETTE.concrete;
    const geometry = new BoxGeometry(...size);
    const mesh = new Mesh(geometry, material(color));
    mesh.name = name;
    mesh.position.set(...position);
    mesh.rotation.set(...rotation);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);

    if (descriptor.edges !== false) {
      const edge = new LineSegments(
        new EdgesGeometry(geometry, 28),
        new LineBasicMaterial({ color: new Color(PALETTE.ink), transparent: true, opacity: 0.18 }),
      );
      edge.renderOrder = 1;
      mesh.add(edge);
    }

    if (descriptor.collider !== false) {
      const quaternion = new Quaternion().setFromEuler(new Euler(...rotation));
      const body = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed()
          .setTranslation(...position)
          .setRotation(quaternion),
      );
      const collider = this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(size[0] / 2, size[1] / 2, size[2] / 2)
          .setFriction(1.1)
          .setRestitution(0),
        body,
      );
      const metadata: SurfaceMetadata = {
        kind: descriptor.surface ?? 'ground',
        handContact: descriptor.handContact ?? false,
        name,
      };
      this.surfaces.set(collider.handle, metadata);
      if (metadata.handContact) this.handContactHandles.add(collider.handle);
    }
    return mesh;
  }

  private addPylon(position: [number, number, number], height: number, color: number): void {
    const geometry = new CylinderGeometry(0.09, 0.13, height, 6);
    const mesh = new Mesh(geometry, material(color));
    mesh.position.set(position[0], position[1] + height / 2, position[2]);
    mesh.castShadow = true;
    this.group.add(mesh);
  }

  private addGate(position: [number, number, number], color: number): void {
    const gate = new Object3D();
    gate.position.set(...position);
    const ring = new Mesh(new TorusGeometry(1.55, 0.055, 5, 24, Math.PI), material(color));
    ring.rotation.z = Math.PI / 2;
    ring.rotation.y = Math.PI / 2;
    ring.position.y = 0.05;
    ring.castShadow = true;
    gate.add(ring);
    this.group.add(gate);
  }

  private build(): void {
    // 01 — response deck.
    this.addBox({
      name: 'Response deck',
      position: [0, -0.5, -7],
      size: [27, 1, 26],
      color: PALETTE.platform,
    });
    this.addBox({
      name: 'Spawn stripe',
      position: [0, 0.012, -14],
      size: [4.8, 0.024, 0.22],
      color: PALETTE.accent,
      collider: false,
      edges: false,
    });
    for (let x = -10; x <= 10; x += 4) this.addPylon([x, 0, -18], 0.7, PALETTE.acid);

    // 02 — grade lane: shallow ramp, high deck, descending staircase.
    this.addBox({
      name: 'Sixteen degree ramp',
      position: [-8.2, 0.93, 1],
      size: [3.8, 0.26, 7],
      rotation: [(-16 * Math.PI) / 180, 0, 0],
      color: PALETTE.concrete,
      surface: 'ramp',
    });
    this.addBox({
      name: 'Ramp summit',
      position: [-8.2, 1.47, 5],
      size: [3.8, 0.3, 2.1],
      color: PALETTE.concreteDark,
      surface: 'landing',
    });
    for (let i = 0; i < 7; i += 1) {
      const height = 1.4 - i * 0.2;
      this.addBox({
        name: `Descending step ${i + 1}`,
        position: [-8.2, height / 2, 6.35 + i * 0.62],
        size: [3.8, height, 0.68],
        color: i % 2 === 0 ? PALETTE.platform : PALETTE.concrete,
        surface: 'step',
      });
    }

    // Central stair calibration with deliberately varied risers.
    const risers = [0.18, 0.38, 0.62, 0.82, 1.02];
    risers.forEach((height, index) => {
      this.addBox({
        name: `Calibration riser ${index + 1}`,
        position: [0, height / 2, -0.2 + index * 0.72],
        size: [4.2, height, 0.78],
        color: index === 4 ? PALETTE.accent : PALETTE.concrete,
        surface: 'step',
      });
    });
    this.addBox({
      name: 'Step observation deck',
      position: [0, 0.91, 4.5],
      size: [4.2, 0.22, 2.4],
      color: PALETTE.concreteDark,
      surface: 'landing',
    });

    // Uneven foot-placement field.
    const tiles: Array<[number, number, number]> = [
      [6.1, 0.12, -0.2],
      [7.5, 0.3, 0.65],
      [9, 0.18, -0.05],
      [10.3, 0.43, 1.1],
      [6.2, 0.38, 2.1],
      [7.8, 0.16, 2.7],
      [9.3, 0.52, 3.1],
      [10.6, 0.26, 3.9],
    ];
    tiles.forEach(([x, height, z], index) => {
      this.addBox({
        name: `Terrain tile ${index + 1}`,
        position: [x, height / 2, z],
        size: [1.25, height, 1.4],
        color: index % 3 === 0 ? PALETTE.blue : PALETTE.concrete,
        surface: 'step',
      });
    });

    // 03 — a shoulder-width contact channel for contextual hand IK.
    this.addBox({
      name: 'Contact channel floor',
      position: [0, -0.34, 15.7],
      size: [6.6, 0.68, 12.4],
      color: PALETTE.concreteDark,
    });
    this.addBox({
      name: 'Left contact wall',
      position: [-1, 0.72, 16.2],
      size: [0.3, 1.44, 7.8],
      color: PALETTE.accent,
      surface: 'contact',
      handContact: true,
    });
    this.addBox({
      name: 'Right contact wall',
      position: [1, 0.72, 16.2],
      size: [0.3, 1.44, 7.8],
      color: PALETTE.accent,
      surface: 'contact',
      handContact: true,
    });
    this.addGate([0, 0.05, 12.6], PALETTE.acid);
    this.addGate([0, 0.05, 20], PALETTE.acid);

    // 04 — jump runway and separated landing pads.
    this.addBox({
      name: 'Jump runway',
      position: [-8.2, 0.25, 14.2],
      size: [3.4, 0.5, 6.4],
      color: PALETTE.platform,
      surface: 'landing',
    });
    this.addBox({
      name: 'Jump landing one',
      position: [-8.2, 0.48, 20.3],
      size: [3.4, 0.96, 3.8],
      color: PALETTE.blue,
      surface: 'landing',
    });
    this.addBox({
      name: 'Jump landing two',
      position: [-8.2, 0.78, 25.6],
      size: [4.5, 1.56, 4.2],
      color: PALETTE.accent,
      surface: 'landing',
    });

    // Over-limit slope proving that the motor respects climb constraints.
    this.addBox({
      name: 'Fifty eight degree rejection ramp',
      position: [8, 2.55, 15.2],
      size: [4, 0.35, 6],
      rotation: [(-58 * Math.PI) / 180, 0, 0],
      color: PALETTE.shadow,
      surface: 'ramp',
    });
    this.addBox({
      name: 'Rejection ramp apron',
      position: [8, -0.25, 11.3],
      size: [7, 0.5, 4.2],
      color: PALETTE.concreteDark,
    });

    // Sparse visual markers make the test zones legible at speed.
    const markers: Array<[number, number, number]> = [
      [-12.2, 0, -1],
      [-12.2, 0, 9],
      [12.2, 0, -1],
      [12.2, 0, 9],
      [-3, 0, 10.5],
      [3, 0, 10.5],
    ];
    markers.forEach((position, index) =>
      this.addPylon(position, index % 2 === 0 ? 1.8 : 1.15, index % 2 === 0 ? PALETTE.acid : PALETTE.accent),
    );
  }
}
