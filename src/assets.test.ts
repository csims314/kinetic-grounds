import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface GlbDocument {
  asset: { version: string };
  nodes?: Array<{ name?: string }>;
  animations?: Array<{ name?: string }>;
  skins?: unknown[];
  meshes?: unknown[];
}

function readGlbJson(relativePath: string): GlbDocument {
  const bytes = readFileSync(resolve(process.cwd(), relativePath));
  expect(bytes.toString('ascii', 0, 4)).toBe('glTF');
  const jsonLength = bytes.readUInt32LE(12);
  const jsonChunkType = bytes.readUInt32LE(16);
  expect(jsonChunkType).toBe(0x4e4f534a);
  return JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8').replace(/\0+$/, '')) as GlbDocument;
}

describe('bundled Quaternius assets', () => {
  const requiredBones = [
    'pelvis',
    'thigh_l',
    'calf_l',
    'foot_l',
    'ball_l',
    'ball_leaf_l',
    'thigh_r',
    'calf_r',
    'foot_r',
    'ball_r',
    'ball_leaf_r',
    'upperarm_l',
    'lowerarm_l',
    'hand_l',
    'upperarm_r',
    'lowerarm_r',
    'hand_r',
  ];

  it('contains a skinned, authored humanoid with the full IK rig', () => {
    const model = readGlbJson('public/assets/quaternius/night-striker.glb');
    const names = new Set(model.nodes?.map((node) => node.name));
    expect(model.asset.version).toBe('2.0');
    expect(model.skins).toHaveLength(1);
    expect(model.meshes?.length).toBeGreaterThan(0);
    for (const bone of requiredBones) expect(names.has(bone)).toBe(true);
  });

  it('contains all semantic locomotion clips on the same bone hierarchy', () => {
    const library = readGlbJson('public/assets/quaternius/universal-animation-library.glb');
    const nodes = new Set(library.nodes?.map((node) => node.name));
    const clips = new Set(library.animations?.map((animation) => animation.name));
    for (const bone of requiredBones) expect(nodes.has(bone)).toBe(true);
    for (const clip of [
      'Idle_Loop',
      'Walk_Loop',
      'Jog_Fwd_Loop',
      'Sprint_Loop',
      'Jump_Start',
      'Jump_Loop',
      'Jump_Land',
    ]) {
      expect(clips.has(clip)).toBe(true);
    }
  });
});
