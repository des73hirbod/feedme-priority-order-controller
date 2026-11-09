import test from 'node:test';
import assert from 'node:assert/strict';
import {createController} from '../src/controller.js';
import {createRuntime} from '../src/runtime.js';

const S = 1_000_000_000n;
function setup() {
  let now = 0n;
  const controller = createController();
  const events = [], timers = [], canceled = [];
  const runtime = createRuntime({controller, emit:event=>events.push(event), clock:()=>now,
    setTimer:(callback,ms)=>{const timer={callback,ms};timers.push(timer);return timer;},
    clearTimer:timer=>canceled.push(timer)});
  return {controller,events,timers,canceled,runtime,setNow:value=>{now=value;}};
}

test('runtime rechecks early wakeup and completes autonomously at due time', () => {
  const h=setup();
  h.runtime.accept({op:'bot-add'}); h.runtime.accept({op:'order',customerClass:'NORMAL'});
  assert.equal(h.timers.at(-1).ms,10000);
  h.setNow(10n*S-1n); h.timers.at(-1).callback();
  assert.deepEqual(h.controller.getSnapshot().completed,[]);
  assert.equal(h.timers.at(-1).ms,1);
  h.setNow(10n*S);h.timers.at(-1).callback();
  assert.deepEqual(h.controller.getSnapshot().completed,[1001]);
  assert.equal(h.events.filter(e=>e.kind==='order-completed').length,1);
  assert.equal(h.controller.nextDue(),null);
});

test('AT-A01 runtime late wakeup catches all downstream deadlines at their own times', () => {
  const h=setup();
  for(let i=0;i<3;i++)h.runtime.accept({op:'order',customerClass:'NORMAL'});
  h.runtime.accept({op:'bot-add'});
  h.setNow(100n*S);h.timers.at(-1).callback();
  assert.deepEqual(h.controller.getSnapshot().completed,[1001,1002,1003]);
  assert.deepEqual(h.events.filter(e=>e.kind==='order-completed').map(e=>e.logicalTimeNs),[10n*S,20n*S,30n*S]);
});

test('stale callbacks after remove/restart cannot resurrect canceled attempts', () => {
  const h=setup();
  h.runtime.accept({op:'bot-add'});h.runtime.accept({op:'order',customerClass:'NORMAL'});
  const old=h.timers.at(-1);
  h.setNow(4n*S);h.runtime.accept({op:'bot-remove'});h.runtime.accept({op:'bot-add'});
  assert.ok(h.canceled.includes(old));
  h.setNow(10n*S);const before=h.events.length;old.callback();
  assert.equal(h.events.length,before);
  assert.deepEqual(h.controller.getSnapshot().completed,[]);
  h.setNow(14n*S);h.timers.at(-1).callback();
  assert.deepEqual(h.controller.getSnapshot().completed,[1001]);
  assert.equal(h.events.find(e=>e.kind==='order-completed').worker_id,2);
});

test('AT-A07 close cancels wakeup and stale callback emits no events', () => {
  for(const op of ['quit','eof']) {
    const h=setup();h.runtime.accept({op:'bot-add'});h.runtime.accept({op:'order',customerClass:'NORMAL'});
    const callback=h.timers.at(-1).callback;
    h.setNow(3n*S);h.runtime.accept({op});
    assert.equal(h.runtime.isClosed(),true);
    const count=h.events.length;h.setNow(20n*S);callback();h.runtime.accept({op:'bot-add'});
    assert.equal(h.events.length,count);
    assert.equal(h.events.at(-1).kind,'session-closed');
    assert.equal(h.controller.nextDue(),null);
  }
});
