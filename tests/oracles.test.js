import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { at, harness, identity, normal, vip, request } from './helpers.js';

const fixture = (filename, sha256) => {
  const bytes = readFileSync(new URL(`./fixtures/${filename}`, import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256, 'frozen oracle bytes must remain unchanged');
  return JSON.parse(bytes.toString('utf8'));
};

// Test-only vocabulary, deliberately independent of the production CLI parser.
const inputs = {
  'order normal': normal(), 'order vip': vip(),
  'bot add': request('bot-add'), 'bot remove': request('bot-remove'),
};
const semantic = (event) => {
  const record = { at_ns: event.logicalTimeNs.toString(), kind: event.kind };
  for (const key of ['order_id', 'worker_id', 'state', 'customer_class']) {
    if (key in event) record[key] = event[key];
  }
  return record;
};

test('AT-19 unchanged sixteen commands match all ten frozen identity checkpoints', () => {
  const oracle = fixture('AT19_STRESS_FIXTURE_R3.json', 'c990df52933083ee50c6bd12fefe55ced06931158bd12066f1d68e81eefe58d1');
  assert.equal(oracle.commands.length, 16);
  assert.deepEqual(oracle.commands.map((command) => command.ordinal), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  assert.deepEqual(oracle.checkpoints.map((checkpoint) => checkpoint.time_s), [0, 2, 3, 10, 13, 20, 21, 30, 40, 50]);
  const h = harness();
  let index = 0;
  for (const time of [0, 2, 3, 10, 13, 20, 21, 23, 30, 40, 50]) {
    while (index < oracle.commands.length && oracle.commands[index].time_s <= time) {
      const command = oracle.commands[index++];
      h.accept(at(command.time_s), inputs[command.command]);
    }
    const settled = h.settle(at(time));
    const checkpoint = oracle.checkpoints.find((item) => item.time_s === time);
    if (checkpoint) {
      assert.deepEqual(identity(h.snapshot()), identity(checkpoint), `${checkpoint.label} at t${time}`);
      assert.equal(h.snapshot().timeNs, at(time).toString());
      assert.equal(h.snapshot().submitted, 10);
      assert.deepEqual([...h.snapshot().pending, ...Object.values(h.snapshot().processing), ...h.snapshot().completed].sort((a, b) => a - b), [1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1010]);
    }
    if (time === 23) {
      assert.deepEqual(settled.events, [], 'canceled B4 deadline at 23 is inert');
      assert.deepEqual(h.snapshot().pending, [1003, 1009, 1010]);
      assert.deepEqual(h.snapshot().processing, { 1: 1005, 2: 1007 });
    }
  }
  assert.equal(index, 16);
  assert.deepEqual(h.snapshot().completed, [1002, 1004, 1006, 1008, 1001, 1005, 1007, 1003, 1009, 1010]);
  assert.deepEqual(h.snapshot().interrupted_history, [1006, 1003]);
  for (const guard of oracle.canceled_attempt_guards) {
    assert.equal(h.events.some((event) => event.kind === 'order-completed' && event.worker_id === guard.worker_id && event.order_id === guard.order_id), false, `canceled B${guard.worker_id} attempt never completes`);
  }
  assert.deepEqual(h.events.filter((event) => event.kind === 'order-completed' && event.order_id === 1003).map((event) => [event.worker_id, event.logicalTimeNs]), [[1, at(40)]]);
});

test('AT-A05 independent R05 fixture matches every semantic event and seven checkpoints', () => {
  const oracle = fixture('R05_DEMO_ORACLE_STAGE04.json', 'f77f65c6c985c9bf17f52fcbdc2c987e030cd5c7126f79ac6a07b5e94eae7fa0');
  const h = harness();
  let checked = 0;
  for (const action of oracle.actions) {
    h.accept(BigInt(action.time_ns), inputs[action.command]);
    for (const checkpoint of oracle.checkpoint_snapshots.filter((item) => item.after_ingress_seq === action.ingress_seq)) {
      assert.deepEqual(identity(h.snapshot()), identity(checkpoint), checkpoint.label);
      assert.equal(h.snapshot().submitted, checkpoint.submitted);
      checked++;
    }
  }
  for (const checkpoint of oracle.checkpoint_snapshots.filter((item) => item.after_ingress_seq === null)) {
    h.settle(BigInt(checkpoint.time_ns));
    assert.deepEqual(identity(h.snapshot()), identity(checkpoint), checkpoint.label);
    assert.equal(h.snapshot().timeNs, checkpoint.time_ns);
    checked++;
  }
  assert.equal(checked, 7);
  assert.deepEqual(h.events.filter((event) => event.logicalTimeNs !== at(2)).map(semantic), oracle.ordered_semantic_events_excluding_t2);
  assert.deepEqual(h.events.filter((event) => event.logicalTimeNs === at(2)).map(semantic).sort((a, b) => a.kind.localeCompare(b.kind)), [...oracle.unordered_t2_group].sort((a, b) => a.kind.localeCompare(b.kind)));
  assert.deepEqual(identity(h.snapshot()), identity(oracle.final));
  const abandoned = h.events.find((event) => event.kind === 'order-started' && event.worker_id === 2);
  assert.equal(h.events.some((event) => event.kind === 'order-completed' && event.attempt_id === abandoned.attempt_id), false);
  for (const expected of oracle.expected_latest_attempts) {
    const completion = h.events.find((event) => event.kind === 'order-completed' && event.order_id === expected.order_id);
    const start = h.events.find((event) => event.kind === 'order-started' && event.attempt_id === completion.attempt_id);
    assert.equal(start.logicalTimeNs.toString(), expected.pickup_ns);
    assert.equal(completion.logicalTimeNs.toString(), expected.completion_ns);
  }
});

test('seeded metamorphic replay preserves semantics under extra observations and finer settlement', () => {
  // Supporting metamorphic evidence, never a substitute for the fixed fixtures.
  const SEED = 0x5eed2026;
  let seed = SEED;
  let time = 0n;
  const actions = [];
  const choices = [normal(), vip(), request('bot-add'), request('bot-remove'), request('status'), request('help'), { op: 'invalid', reasonCode: 'SEEDED_BAD_INPUT' }];
  for (let index = 0; index < 160; index++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    time += at(seed % 4);
    actions.push({ time, input: choices[(seed >>> 8) % choices.length] });
  }
  function replay(extraObservations = false, fineSettlement = false) {
    const h = harness();
    let last = 0n;
    for (const action of actions) {
      if (fineSettlement) for (let second = last + at(1); second < action.time; second += at(1)) h.settle(second);
      if (extraObservations) {
        h.accept(action.time, request('status'));
        h.accept(action.time, request('help'));
      }
      h.accept(action.time, action.input);
      last = action.time;
    }
    h.settle(time + at(1000));
    return h;
  }
  const a = replay(); const b = replay(); const c = replay(true, true);
  assert.deepEqual(a.events, b.events, `repeatability for seed ${SEED}`);
  assert.deepEqual(a.snapshot(), b.snapshot());
  const businessEvents = (h) => h.events.filter((event) => !['status', 'help', 'command-rejected'].includes(event.kind)).map(({ ingress_seq, ...event }) => event);
  assert.deepEqual(businessEvents(a), businessEvents(c), `observation and clock-granularity invariance for seed ${SEED}`);
  assert.deepEqual(a.snapshot(), c.snapshot());
});
