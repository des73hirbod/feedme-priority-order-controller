import { closeSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = join(root, 'scripts/result.txt');
let temporary;

try {
  // Remove even a valid-looking old sample before checking or invoking the app.
  rmSync(target, { force: true });
  temporary = mkdtempSync(join(root, 'scripts/.demo-'));
  const candidate = join(temporary, 'result.txt');
  const output = openSync(candidate, 'wx');
  let demo;
  try {
    demo = spawnSync(process.execPath, [join(root, 'src/main.js'), '--demo'], {
      cwd: root, stdio: ['ignore', output, 'pipe'], encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    });
  } finally {
    closeSync(output);
  }
  const text = readFileSync(candidate, 'utf8');
  if (demo.stderr) process.stderr.write(demo.stderr);
  if (demo.error || demo.status !== 0) {
    if (text) process.stderr.write(`Rejected partial demo stdout (${Buffer.byteLength(text)} bytes):\n${text}\n`);
    process.exitCode = demo.status || 1;
    throw new Error(demo.error ? `Demo watchdog/startup failed: ${demo.error.message}` : `Demo exited ${demo.status ?? demo.signal}`);
  }
  if (!text.trim()) throw new Error('Demo produced missing/empty output; previous result was removed');
  const check = spawnSync(process.execPath, [join(root, 'tests/verify-demo.js'), candidate], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
  });
  if (check.stdout) process.stdout.write(check.stdout);
  if (check.stderr) process.stderr.write(check.stderr);
  if (check.error || check.status !== 0) {
    process.stderr.write(`Rejected demo stdout (${Buffer.byteLength(text)} bytes):\n${text}\n`);
    throw new Error(check.error ? `Independent checker failed: ${check.error.message}` : 'Independent R05 checker rejected demo output');
  }
  renameSync(candidate, target);
  process.stdout.write('Fresh demo verified at scripts/result.txt.\n');
} catch (error) {
  process.stderr.write(`Demo verification failed: ${error.message}\n`);
  process.exitCode ||= 1;
} finally {
  if (temporary) {
    const cleanupTarget = resolve(temporary);
    if (dirname(cleanupTarget) !== resolve(root, 'scripts') || !basename(cleanupTarget).startsWith('.demo-')) throw new Error('Refusing demo cleanup outside its generated scripts child');
    rmSync(cleanupTarget, { recursive: true, force: true });
  }
}
