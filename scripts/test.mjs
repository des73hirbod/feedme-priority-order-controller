import { readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const required = ['adapters', 'controller', 'delivery', 'live', 'log-negative', 'oracles', 'process', 'runtime'].map((name) => `tests/${name}.test.js`);
const normalize = (name) => name.replaceAll('\\', '/').replace(/\/+/g, '/');

function discover(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? discover(path) : entry.isFile() && entry.name.endsWith('.test.js') ? [path] : [];
  });
}

try {
  const files = discover(join(root, 'tests')).sort();
  const names = files.map((path) => normalize(relative(root, path)));
  for (const name of required) {
    if (!names.includes(name)) throw new Error(`Missing required test suite: ${name}`);
    if (statSync(join(root, name)).size === 0 || !readFileSync(join(root, name), 'utf8').trim()) throw new Error(`Empty required test suite: ${name}`);
  }
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  else {
    // Node otherwise treats a file with zero registered tests as a passing file
    // subtest. Reject that fallback for every required suite after real execution.
    const fallbackNames = result.stdout.split(/\r?\n/).filter((line) => line.startsWith('# Subtest: ')).map((line) => {
      const name = normalize(line.slice(11));
      return isAbsolute(name) ? normalize(relative(root, name)) : name;
    });
    for (const name of required) if (fallbackNames.includes(name)) throw new Error(`Required suite registered no tests: ${name}`);
    if (!/^# tests [1-9]\d*$/m.test(result.stdout)) throw new Error('Test runner reported no executed tests');
  }
} catch (error) {
  process.stderr.write(`Test verification failed: ${error.message}\n`);
  process.exitCode = 1;
}
