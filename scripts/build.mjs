import { accessSync, constants, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const expectedSources = ['controller', 'cli', 'log', 'runtime', 'demo', 'main'].map((name) => `src/${name}.js`);
const expectedScripts = ['test', 'build', 'run', 'ci-faults'].map((name) => `scripts/${name}.mjs`);

function execute(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 10000, windowsHide: true });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Node check failed (${result.status ?? result.signal}): ${args.join(' ')}`);
}

try {
  const extras = readdirSync(join(root, 'src')).filter((name) => name.endsWith('.js')).map((name) => `src/${name}`);
  const files = [...new Set([...expectedSources, ...expectedScripts, ...extras])];
  for (const file of files) {
    accessSync(join(root, file), constants.R_OK);
    execute(['--check', join(root, file)]);
  }
  // Plain JavaScript has no compilation stage. Importing the guarded entrypoint
  // resolves its complete static dependency graph without starting a session.
  execute(['--input-type=module', '--eval', `await import(${JSON.stringify(pathToFileURL(join(root, 'src/main.js')).href)});`]);
  process.stdout.write(`Build verified: ${files.length} JavaScript files parsed; entrypoint imports resolved.\n`);
} catch (error) {
  process.stderr.write(`Build verification failed: ${error.message}\n`);
  process.exitCode = 1;
}
