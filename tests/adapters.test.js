import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, COMMANDS } from '../src/cli.js';
import { createFormatter } from '../src/log.js';

// Breaks caught: accepting unsupported tokens/case, consuming IDs for bad input,
// losing exact nanoseconds, or using wall-clock arithmetic for logical deadlines.
test('parser accepts exactly R3 grammar with flexible whitespace', () => {
  const cases = [
    ['  order\t normal  ', {op:'order',customerClass:'NORMAL'}],
    ['order vip', {op:'order',customerClass:'VIP'}],
    ['bot  add', {op:'bot-add'}], ['bot remove', {op:'bot-remove'}],
    ['status', {op:'status'}], ['help', {op:'help'}], ['quit', {op:'quit'}],
  ];
  for (const [text, expected] of cases) assert.deepEqual(parseCommand(text), expected);
  assert.deepEqual(COMMANDS, ['order normal','order vip','bot add','bot remove','status','help','quit']);
});

test('AT-20 parser rejects blank, case changes, extra/missing and unknown tokens', () => {
  for (const text of ['', '   ', 'ORDER normal', 'order', 'order VIP', 'bot',
    'bot add extra', 'status extra', 'quit now', 'help more', 'cancel 1001', 'order normal vip']) {
    const parsed = parseCommand(text);
    assert.equal(parsed.op, 'invalid', text);
    assert.equal(typeof parsed.reasonCode, 'string');
    assert.ok(parsed.reasonCode.length);
  }
});

test('formatter declares simulation, preserves exact offsets and sequences every line', () => {
  const format = createFormatter({mode:'SIMULATED'});
  const start = JSON.parse(format({kind:'run-started',logicalTimeNs:0n,anchor_utc:'12:00:00 UTC'}));
  const event = JSON.parse(format({kind:'order-started',logicalTimeNs:9999999999n,
    order_id:1001,worker_id:1,attempt_id:'a1',state:'PROCESSING',start_ns:'9999999999',due_ns:'19999999999'}));
  assert.equal(start.schema_version,1); assert.equal(start.event_seq,1);
  assert.equal(start.mode,'SIMULATED'); assert.equal(start.utc,'[12:00:00]');
  assert.equal(event.event_seq,2); assert.equal(event.elapsed_ns,'9999999999');
  assert.equal(event.utc,'[12:00:09]'); assert.ok(!('logicalTimeNs' in event));
});

test('AT-A08 UTC midnight rollover uses positive monotonic offsets', () => {
  const format = createFormatter({mode:'SIMULATED',anchorUtc:'23:59:55 UTC'});
  const pickup = JSON.parse(format({kind:'order-started',logicalTimeNs:0n}));
  const done = JSON.parse(format({kind:'order-completed',logicalTimeNs:10000000000n}));
  assert.equal(pickup.utc,'[23:59:55]');
  assert.equal(done.utc,'[00:00:05]'); assert.equal(done.elapsed_ns,'10000000000');
  const huge = JSON.parse(format({kind:'status',logicalTimeNs:9007199254740993000000000n}));
  assert.equal(huge.elapsed_ns,'9007199254740993000000000');
});

test('LIVE UTC reflects observation independently from logical deadline', () => {
  const format = createFormatter({mode:'LIVE',nowUtc:()=>new Date('2026-11-09T18:42:53Z')});
  const event = JSON.parse(format({kind:'order-completed',logicalTimeNs:10000000000n}));
  assert.equal(event.utc,'[18:42:53]'); assert.equal(event.elapsed_ns,'10000000000');
  assert.equal(event.mode,'LIVE');
});
