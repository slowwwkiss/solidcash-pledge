// Compile contracts/*.scash -> artifacts/*.json with the SolidCash compiler.
// Usage: node tasks/compile.mjs
// (Mirrors examples/testing-suite/tasks/compile.ts, minus the TS/tsx tooling.)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const contractsDir = path.join(root, 'contracts');
const artifactsDir = path.join(root, 'artifacts');
fs.mkdirSync(artifactsDir, { recursive: true });

const { compileString } = await import('@solidcash/solidc');
const { formatArtifact } = await import('@solidcash/utils');

let failed = false;
for (const fn of fs.readdirSync(contractsDir).filter((f) => f.endsWith('.scash'))) {
  const src = fs.readFileSync(path.join(contractsDir, fn), 'utf-8');
  const out = path.join(artifactsDir, fn.replace('.scash', '.json'));
  try {
    const artifact = compileString(src);
    fs.writeFileSync(out, formatArtifact(artifact, 'json'));
    console.log(`compiled ${fn} -> artifacts/${path.basename(out)} ` +
      `(bytecode ${artifact.bytecode.length / 2} bytes)`);
  } catch (e) {
    console.error(`FAILED ${fn}: ${e.message}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
