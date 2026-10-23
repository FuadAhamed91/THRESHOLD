// Rebuild the Blender assets (public/models/*.glb) from blender/scripts.
//   npm run assets            (uses $BLENDER or common install locations)
//   npm run assets -- --fast  (256 px textures for quick iteration)
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function findBlender() {
  if (process.env.BLENDER && existsSync(process.env.BLENDER)) return process.env.BLENDER;
  const candidates = [];
  const roots = [
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Blender Foundation'),
    'C:\\Program Files\\Blender Foundation',
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const dir of readdirSync(root).sort().reverse()) candidates.push(join(root, dir, 'blender.exe'));
  }
  candidates.push('/Applications/Blender.app/Contents/MacOS/Blender', '/usr/bin/blender', '/snap/bin/blender');
  return candidates.find((c) => existsSync(c)) ?? 'blender';
}

const blender = findBlender();
const extra = process.argv.slice(2);
console.log(`Using ${blender}`);
const r = spawnSync(blender, ['-b', '--factory-startup', '--python', 'blender/scripts/build_entrance.py', '--', ...extra], { stdio: 'inherit' });
process.exit(r.status ?? 1);
