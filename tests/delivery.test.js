import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const project = fileURLToPath(new URL('../', import.meta.url));
const suites = ['adapters', 'controller', 'delivery', 'live', 'log-negative', 'oracles', 'process', 'runtime'];
const windowsShellCandidates = [
  'C:/Program Files/Git/bin/bash.exe',
  'C:/Program Files (x86)/Git/bin/bash.exe',
  ...(process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, 'Programs/Git/bin/bash.exe')] : []),
];
const shell = process.env.FEEDME_SHELL || (process.platform === 'win32' ? windowsShellCandidates.find((path) => existsSync(path)) || null : '/bin/sh');
const shellOnly = { skip: shell === null ? 'Shell wrapper verification on Windows requires FEEDME_SHELL or Git Bash; native Node commands remain available.' : false };

function disposable(t, full = false) {
  const root = mkdtempSync(join(tmpdir(), 'feedme-delivery-'));
  t.after(() => {
    const target = resolve(root);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('feedme-delivery-'));
    rmSync(target, { recursive: true, force: true });
  });
  if (full) {
    cpSync(project, root, { recursive: true, filter: (path) => !['result.txt', 'node_modules', '.git'].includes(path.split(/[\\/]/).at(-1)) });
  } else {
    mkdirSync(join(root, 'scripts'));
    cpSync(join(project, 'scripts'), join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  }
  return root;
}

function command(root, script, timeout = 15000) {
  const env = { ...process.env };
  // These child commands run independent disposable projects. Inheriting Node's
  // private test-worker marker would suppress their deliberate test discovery.
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [join(root, 'scripts', script)], {
    cwd: root, input: '', encoding: 'utf8', timeout, windowsHide: true, env,
  });
  assert.ifError(result.error);
  return result;
}

function writeSuites(root) {
  mkdirSync(join(root, 'tests'));
  for (const name of suites) {
    writeFileSync(join(root, 'tests', `${name}.test.js`), `import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('${name} discovery witness', () => assert.equal(2 + 2, 4));\n`);
  }
}

test('test runner executes discovered assertions and rejects missing or empty required suites', (t) => {
  // Omitting required discovery or silently accepting an empty suite must fail.
  const root = disposable(t);
  writeSuites(root);
  let result = command(root, 'test.mjs');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /controller discovery witness/);
  assert.match(result.stdout, /# tests 8/);
  rmSync(join(root, 'tests', 'controller.test.js'));
  result = command(root, 'test.mjs');
  assert.notEqual(result.status, 0, 'missing required suite was accepted');
  writeFileSync(join(root, 'tests', 'controller.test.js'), '// no assertions or test registrations\n');
  result = command(root, 'test.mjs');
  assert.notEqual(result.status, 0, 'empty required suite was accepted');
});

test('test runner discovers an additional failing suite and propagates its nonzero exit', (t) => {
  const root = disposable(t);
  writeSuites(root);
  writeFileSync(join(root, 'tests', 'injected.test.js'), "import test from 'node:test'; import assert from 'node:assert/strict'; test('delivery failure witness', () => assert.fail('deliberate delivery failure'));\n");
  const result = command(root, 'test.mjs');
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /deliberate delivery failure/);
});

test('build checks syntax and resolves entrypoint imports instead of echoing success', (t) => {
  const root = disposable(t);
  mkdirSync(join(root, 'src'));
  for (const name of ['controller', 'cli', 'runtime', 'log', 'demo']) writeFileSync(join(root, 'src', `${name}.js`), 'export const ready = true;\n');
  writeFileSync(join(root, 'src', 'main.js'), "import './controller.js'; import './cli.js'; import './runtime.js'; import './log.js'; import './demo.js';\n");
  let result = command(root, 'build.mjs');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  writeFileSync(join(root, 'src', 'controller.js'), 'export const broken = ;\n');
  result = command(root, 'build.mjs');
  assert.notEqual(result.status, 0, 'invalid source syntax was accepted');
  writeFileSync(join(root, 'src', 'controller.js'), 'export const ready = true;\n');
  writeFileSync(join(root, 'src', 'main.js'), "import './missing-module.js';\n");
  result = command(root, 'build.mjs');
  assert.notEqual(result.status, 0, 'unresolved startup import was accepted');
});

test('fresh real demo replaces a stale sentinel at exactly scripts/result.txt', (t) => {
  const root = disposable(t, true);
  const target = join(root, 'scripts', 'result.txt');
  writeFileSync(target, 'STALE DELIVERY SENTINEL\n');
  const result = command(root, 'run.mjs');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const text = readFileSync(target, 'utf8');
  assert.ok(text.trim().length > 0);
  assert.ok(!text.includes('STALE DELIVERY SENTINEL'));
  assert.equal(existsSync(join(root, 'result.txt')), false, 'wrong root result path was generated');
  const verification = spawnSync(process.execPath, ['tests/verify-demo.js', 'scripts/result.txt'], { cwd: root, input: '', encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.ifError(verification.error);
  assert.equal(verification.status, 0, verification.stdout + verification.stderr);
});

test('missing or incorrect demo output cannot reuse the previous result', (t) => {
  const root = disposable(t, true);
  const target = join(root, 'scripts', 'result.txt');
  for (const source of ["process.exit(0);\n", "process.stdout.write('{}\\n');\n"]) {
    writeFileSync(target, 'STALE DELIVERY SENTINEL\n');
    writeFileSync(join(root, 'src', 'main.js'), source);
    const result = command(root, 'run.mjs');
    assert.notEqual(result.status, 0, 'absent/malformed demo output was accepted');
    assert.equal(existsSync(target), false, 'stale or rejected result remained trusted');
  }
});

test('partial stdout followed by demo failure propagates the child exit and leaves no accepted result', (t) => {
  const root = disposable(t, true);
  const target = join(root, 'scripts', 'result.txt');
  writeFileSync(target, 'STALE DELIVERY SENTINEL\n');
  writeFileSync(join(root, 'src', 'main.js'), "process.stdout.write('{\"partial\":true}\\n'); process.exitCode = 23;\n");
  const result = command(root, 'run.mjs');
  assert.equal(result.status, 23, result.stdout + result.stderr);
  assert.equal(existsSync(target), false);
});

test('fault runner refuses evidence directories inside its source tree, including a dot-dot-prefixed child name', (t) => {
  const root = disposable(t);
  const evidence = join(root, '..evidence');
  const result = spawnSync(process.execPath, [join(root, 'scripts/ci-faults.mjs'), '--evidence-dir', evidence], {
    cwd: root, input: '', encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(evidence), false, 'fault evidence was created inside the source being copied');
});

test('workflow rejects three echo-only wrappers even with a valid stale demo sample', shellOnly, (t) => {
  const root = disposable(t, true);
  const target = join(root, 'scripts/result.txt');
  writeFileSync(target, readFileSync(join(root, 'tests/fixtures/valid-r05.jsonl')));
  for (const name of ['test', 'build', 'run']) writeFileSync(join(root, `scripts/${name}.sh`), `#!/bin/sh\necho '${name} echo-only adversarial wrapper'\n`);
  const workflow = readFileSync(join(root, '.github/workflows/verify.yml'), 'utf8');
  // Execute the relevant actual workflow commands, retaining freshness/oracle
  // steps as well as all three wrappers. This avoids a second handwritten gate.
  const commands = workflow.split(/\r?\n/).map((line) => /^\s+run: (.+)$/.exec(line)?.[1]).filter((line) => line && /scripts\/(?:test|build|run)\.sh|rm -f scripts\/result\.txt|node tests\/verify-demo\.js scripts\/result\.txt/.test(line));
  const result = spawnSync(shell, ['-c', `set -eu\n${commands.join('\n')}\n`], { cwd: root, input: '', encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, `workflow falsely accepted echo-only wrappers and stale sample:\n${result.stdout}${result.stderr}`);
  for (const name of ['test', 'build', 'run']) assert.match(result.stdout, new RegExp(`${name} echo-only adversarial wrapper`));
  assert.equal(existsSync(target), false, 'workflow did not independently remove the stale result');
});

test('fault shell mode forwards every case through its exact wrapper without running full tests', shellOnly, (t) => {
  const root = disposable(t, true);
  const evidenceParent = mkdtempSync(join(tmpdir(), 'feedme-delivery-'));
  t.after(() => {
    const target = resolve(evidenceParent);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('feedme-delivery-'));
    rmSync(target, { recursive: true, force: true });
  });
  const evidence = join(evidenceParent, 'fault-probe');
  const inheritedEvidence = join(evidenceParent, 'pristine-live');
  mkdirSync(inheritedEvidence);
  const sentinel = join(inheritedEvidence, 'sentinel.json');
  writeFileSync(sentinel, '{"pristine":true}\n');
  for (const name of ['test', 'build', 'run']) writeFileSync(join(root, `scripts/${name}.sh`), `#!/bin/sh\necho 'SHELL-WITNESS ${name}.sh'\nprintf 'EVIDENCE-WITNESS %s\\n' "$FEEDME_EVIDENCE_DIR"\nprintf 'CONTEXT-WITNESS %s\\n' "\${NODE_TEST_CONTEXT-unset}"\nexit 29\n`);
  const result = spawnSync(process.execPath, [join(root, 'scripts/ci-faults.mjs'), '--shell', shell, '--evidence-dir', evidence], {
    cwd: root, input: '', encoding: 'utf8', timeout: 15000, windowsHide: true,
    env: { ...process.env, FEEDME_EVIDENCE_DIR: inheritedEvidence, NODE_TEST_CONTEXT: 'outer-delivery-witness' },
  });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, 'witness wrappers should not satisfy the real fault oracles');
  assert.ok(existsSync(join(evidence, 'summary.json')), `shell forwarding was not exercised:\n${result.stdout}${result.stderr}`);
  const report = JSON.parse(readFileSync(join(evidence, 'summary.json'), 'utf8'));
  assert.equal(report.execution_mode, 'shell');
  assert.equal(report.cases.length, 6);
  for (const entry of report.cases) {
    assert.equal(entry.executable, shell);
    assert.deepEqual(entry.argv, [`scripts/${entry.id === 'CI-F01' ? 'test' : entry.id === 'CI-F02' ? 'build' : 'run'}.sh`]);
    assert.equal(entry.exit_code, 29);
    const output = readFileSync(join(evidence, entry.id, 'stdout.txt'), 'utf8');
    assert.match(output, /SHELL-WITNESS/);
    assert.equal(entry.live_evidence_dir, join(evidence, entry.id, 'live-evidence'));
    assert.ok(output.includes(`EVIDENCE-WITNESS ${entry.live_evidence_dir}`), output);
    assert.match(output, /CONTEXT-WITNESS unset/);
    assert.equal(entry.restored_copy_matches_pristine, true);
    assert.equal(entry.disposable_copy_removed, true);
  }
  assert.equal(readFileSync(sentinel, 'utf8'), '{"pristine":true}\n');
  // The second argument order must reach the path guard, not fail parsing.
  const invalid = spawnSync(process.execPath, [join(root, 'scripts/ci-faults.mjs'), '--evidence-dir', join(root, 'inside'), '--shell', shell], { cwd: root, input: '', encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.ifError(invalid.error);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /must be outside the source project/);
});
