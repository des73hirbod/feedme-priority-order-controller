import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const normalize = (path) => path.replaceAll('\\', '/');
const excluded = (name) => ['.git', 'node_modules', '.superpowers', '.env'].includes(name) || name.startsWith('.demo-');

function manifest(directory, prefix = '') {
  const result = {};
  for (const entry of readdirSync(join(directory, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (excluded(entry.name)) continue;
    const path = normalize(join(prefix, entry.name));
    if (path === 'scripts/result.txt') continue;
    if (entry.isDirectory()) Object.assign(result, manifest(directory, path));
    else if (entry.isFile()) result[path] = sha256(readFileSync(join(directory, path)));
    else throw new Error(`Unsupported source-tree entry: ${path}`);
  }
  return result;
}

function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function save(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }
function diff(path, before, after) {
  const oldLines = before === null ? [] : before.toString('utf8').replace(/\n$/, '').split('\n');
  const newLines = after.toString('utf8').replace(/\n$/, '').split('\n');
  return `--- ${before === null ? '/dev/null' : `a/${path}`}\n+++ b/${path}\n@@ -${oldLines.length ? 1 : 0},${oldLines.length} +1,${newLines.length} @@\n${oldLines.map((line) => `-${line}\n`).join('')}${newLines.map((line) => `+${line}\n`).join('')}`;
}

const mutations = [
  {
    id: 'CI-F01', helper: 'test.mjs', expected: 'A deliberately failing real node:test assertion makes the test step nonzero.',
    modify: () => [{ path: 'tests/ci-injected.test.js', content: "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('CI-F01 intentional failing assertion', () => assert.fail('CI-F01 deliberate assertion failure'));\n" }],
    accept: (run) => run.status !== 0 && run.output.includes('CI-F01 deliberate assertion failure'),
  },
  {
    id: 'CI-F02', helper: 'build.mjs', expected: 'Invalid JavaScript in an expected production source makes the build step nonzero.',
    modify: (copy) => [{ path: 'src/controller.js', content: `${readFileSync(join(copy, 'src/controller.js'), 'utf8')}\nexport const CI_F02_BROKEN = ;\n` }],
    accept: (run) => run.status !== 0 && /SyntaxError|Unexpected token/.test(run.output),
  },
  {
    id: 'CI-F03', helper: 'run.mjs', expected: 'Redirecting application stdout to the wrong root result path cannot produce accepted scripts/result.txt.',
    modify: () => [{ path: 'src/main.js', content: "import { writeFileSync } from 'node:fs';\nwriteFileSync('result.txt', 'CI-F03 redirected output\\n');\n" }],
    accept: (run, copy) => run.status !== 0 && !existsSync(join(copy, 'scripts/result.txt')) && existsSync(join(copy, 'result.txt')),
  },
  {
    id: 'CI-F04', helper: 'run.mjs', expected: 'A valid old timestamped sample is deleted before a successful child that emits no new output.',
    modify: (copy) => [
      { path: 'scripts/result.txt', content: readFileSync(join(copy, 'tests/fixtures/valid-r05.jsonl'), 'utf8') },
      { path: 'src/main.js', content: '// CI-F04 successful app invocation deliberately emits no new output.\nprocess.exitCode = 0;\n' },
    ],
    accept: (run, copy) => run.status !== 0 && !existsSync(join(copy, 'scripts/result.txt')) && /missing\/empty output/.test(run.output),
  },
  {
    id: 'CI-F05', helper: 'run.mjs', expected: 'Mutating the first real completion order ID is rejected by the independent R05 checker.',
    modify: (copy) => [{ path: 'src/main.js', content: `// CI-F05: corrupt one actual application event after the controller produces it.\nconst ciOriginalWrite = process.stdout.write.bind(process.stdout);\nlet ciMutated = false;\nprocess.stdout.write = function (...args) {\n  const text = String(args[0]);\n  args[0] = text.split('\\n').map((line) => {\n    if (!line || ciMutated) return line;\n    const event = JSON.parse(line);\n    if (event.kind === 'order-completed') {\n      event.order_id = 999999;\n      ciMutated = true;\n      process.stderr.write('CI-F05 mutated actual completion order_id\\n');\n      return JSON.stringify(event);\n    }\n    return line;\n  }).join('\\n');\n  return ciOriginalWrite(...args);\n};\n${readFileSync(join(copy, 'src/main.js'), 'utf8')}` }],
    accept: (run) => run.status !== 0 && run.output.includes('CI-F05 mutated actual completion order_id') && run.output.includes('Independent R05 checker rejected'),
  },
  {
    id: 'CI-F06', helper: 'run.mjs', expected: 'A child that writes partial output then exits 23 fails even though bytes were generated.',
    modify: (copy) => {
      const firstLine = readFileSync(join(copy, 'tests/fixtures/valid-r05.jsonl'), 'utf8').split(/\r?\n/)[0];
      return [{ path: 'src/main.js', content: `process.stdout.write(${JSON.stringify(`${firstLine}\n`)});\nprocess.exitCode = 23;\n` }];
    },
    accept: (run) => run.status === 23 && /Rejected partial demo stdout \([1-9]\d* bytes\)/.test(run.output),
  },
];

let evidence;
try {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!['--evidence-dir', '--shell'].includes(name) || !args[index + 1] || Object.hasOwn(options, name)) throw new Error('Usage: node scripts/ci-faults.mjs [--evidence-dir PATH] [--shell PATH]');
    options[name] = args[index + 1];
  }
  const shell = options['--shell'];
  evidence = options['--evidence-dir'] ? resolve(options['--evidence-dir']) : mkdtempSync(join(tmpdir(), 'feedme-ci-evidence-'));
  const evidenceRelative = relative(root, evidence);
  const outsideProject = evidenceRelative === '..' || evidenceRelative.startsWith(`..${sep}`) || isAbsolute(evidenceRelative);
  if (!outsideProject) throw new Error('Fault evidence directory must be outside the source project');
  if (existsSync(evidence) && readdirSync(evidence).length) throw new Error('Fault evidence directory must be empty for this invocation');
  mkdirSync(evidence, { recursive: true });
  const before = manifest(root);
  save(join(evidence, 'pristine-before.json'), before);
  const report = { schema_version: 1, started_utc: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch, commit: process.env.GITHUB_SHA || 'UNCOMMITTED_LOCAL', execution_mode: shell ? 'shell' : 'node', shell: shell || null, cases: [] };
  for (const mutation of mutations) {
    const caseDirectory = join(evidence, mutation.id);
    mkdirSync(caseDirectory);
    const copy = mkdtempSync(join(tmpdir(), `feedme-${mutation.id}-`));
    let entry;
    try {
      cpSync(root, copy, { recursive: true, filter: (path) => !excluded(path.split(/[\\/]/).at(-1)) && normalize(relative(root, path)) !== 'scripts/result.txt' });
      const initialCopyMatches = same(before, manifest(copy));
      if (!initialCopyMatches) throw new Error(`Disposable copy did not match pristine source: ${mutation.id}`);
      const changes = mutation.modify(copy).map((change) => ({ ...change, before: existsSync(join(copy, change.path)) ? readFileSync(join(copy, change.path)) : null }));
      writeFileSync(join(caseDirectory, 'injected.diff'), changes.map((change) => diff(change.path, change.before, Buffer.from(change.content))).join('\n'));
      for (const change of changes) writeFileSync(join(copy, change.path), change.content);
      const executable = shell || process.execPath;
      const argv = [shell ? `scripts/${mutation.helper.replace(/\.mjs$/, '.sh')}` : join(copy, 'scripts', mutation.helper)];
      const liveEvidence = join(caseDirectory, 'live-evidence');
      const env = { ...process.env, FEEDME_EVIDENCE_DIR: liveEvidence };
      // This child is an independent copied project; isolate evidence and clear
      // Node's private worker marker instead of reusing the caller's test run.
      delete env.NODE_TEST_CONTEXT;
      const started = new Date().toISOString();
      const result = spawnSync(executable, argv, { cwd: copy, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 150000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env });
      writeFileSync(join(caseDirectory, 'stdout.txt'), result.stdout || '');
      writeFileSync(join(caseDirectory, 'stderr.txt'), result.stderr || '');
      const run = { status: result.status, output: (result.stdout || '') + (result.stderr || '') };
      entry = { id: mutation.id, expected: mutation.expected, execution_mode: shell ? 'shell' : 'node', executable, argv, cwd: copy, live_evidence_dir: liveEvidence, started_utc: started, exit_code: result.status, signal: result.signal, spawn_error: result.error?.message || null, passed: !result.error && mutation.accept(run, copy), initial_copy_matches_pristine: initialCopyMatches, accepted_result_exists: existsSync(join(copy, 'scripts/result.txt')) };
      // Restore every injected source and compare contents before disposing the copy.
      for (const change of changes) {
        if (change.before === null) rmSync(join(copy, change.path), { force: true });
        else writeFileSync(join(copy, change.path), change.before);
      }
      if (!Object.hasOwn(before, 'result.txt')) rmSync(join(copy, 'result.txt'), { force: true });
      const restored = manifest(copy);
      save(join(caseDirectory, 'restored-copy-manifest.json'), restored);
      entry.restored_copy_matches_pristine = same(before, restored);
      entry.pristine_source_unchanged = same(before, manifest(root));
      entry.passed &&= entry.restored_copy_matches_pristine && entry.pristine_source_unchanged;
    } finally {
      const cleanupTarget = resolve(copy);
      if (dirname(cleanupTarget) !== resolve(tmpdir()) || !basename(cleanupTarget).startsWith(`feedme-${mutation.id}-`)) throw new Error('Refusing fault cleanup outside its generated temporary child');
      rmSync(cleanupTarget, { recursive: true, force: true });
    }
    entry.disposable_copy_removed = !existsSync(copy);
    entry.passed &&= entry.disposable_copy_removed;
    save(join(caseDirectory, 'result.json'), entry);
    report.cases.push(entry);
    process.stdout.write(`${entry.id}: ${entry.passed ? 'PASS' : 'FAIL'} (injected command exit ${entry.exit_code})\n`);
  }
  const after = manifest(root);
  save(join(evidence, 'pristine-after.json'), after);
  report.pristine_source_unchanged = same(before, after);
  report.passed = report.pristine_source_unchanged && report.cases.length === 6 && report.cases.every((entry) => entry.passed);
  report.finished_utc = new Date().toISOString();
  save(join(evidence, 'summary.json'), report);
  process.stdout.write(`Fault evidence: ${evidence}\n`);
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`CI fault rehearsal failed: ${error.stack || error.message}\n`);
  if (evidence) process.stderr.write(`Available evidence: ${evidence}\n`);
  process.exitCode = 1;
}
