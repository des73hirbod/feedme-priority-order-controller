import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {launchSession} from './live-harness.js';

const entry=fileURLToPath(new URL('../src/main.js',import.meta.url));
function run(input,args=[]) {
  const result=spawnSync(process.execPath,[entry,...args],{input,encoding:'utf8',timeout:5000});
  assert.equal(result.error,undefined);
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stderr,'');
  assert.ok(result.stdout.trim().length > 0,'CLI must emit structured observations');
  const records=result.stdout.trim().split(/\r?\n/u).map(line=>JSON.parse(line));
  for(let i=0;i<records.length;i++) {
    assert.equal(records[i].event_seq,i+1);
    assert.equal(records[i].schema_version,1);
    assert.match(records[i].utc,/^\[(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\]$/u);
    assert.match(records[i].elapsed_ns,/^(0|[1-9]\d*)$/u);
  }
  return records;
}

test('AT-01 AT-17 CLI rejection/noop/whitespace and help preserve starting IDs', () => {
  const records=run('bot remove\nbot remove\n\nORDER normal\norder\nbot add extra\nhelp\n  order  normal \nstatus\nquit\norder vip\n');
  assert.equal(records.filter(e=>e.kind==='command-noop').length,2);
  assert.equal(records.filter(e=>e.kind==='command-rejected').length,4);
  const created=records.filter(e=>e.kind==='order-created');
  assert.equal(created.length,1);assert.equal(created[0].order_id,1001);
  const status=records.find(e=>e.kind==='status');
  assert.deepEqual(status.snapshot.pending,[1001]);
  assert.deepEqual(status.snapshot.active_workers,[]);
  assert.deepEqual(records.find(e=>e.kind==='help').commands,['order normal','order vip','bot add','bot remove','status','help','quit']);
  assert.equal(records.at(-1).kind,'session-closed');assert.equal(records.at(-1).reason,'quit');
});

test('AT-21 distinct OS processes reset all state and first order/worker IDs', () => {
  for(const termination of ['quit\n','']) {
    const a=run(`bot add\norder normal\n${termination}`);
    assert.equal(a.filter(e=>e.kind==='order-started').length,1);
    assert.equal(a.filter(e=>e.kind==='order-completed').length,0);
    assert.equal(a.at(-1).kind,'session-closed');
    const b=run('status\norder normal\nbot add\nquit\n');
    const state=b.find(e=>e.kind==='status').snapshot;
    for(const key of ['pending','completed','active_workers','idle_workers','interrupted_history'])assert.deepEqual(state[key],[]);
    assert.deepEqual(state.processing,{});assert.equal(state.submitted,0);
    assert.equal(b.find(e=>e.kind==='order-created').order_id,1001);
    assert.equal(b.find(e=>e.kind==='worker-added').worker_id,1);
    assert.equal(b[0].event_seq,1);
  }
});

test('AT-A07 real quit and EOF flush exactly one terminal record', () => {
  for(const [input,reason] of [['bot add\norder normal\nquit\n','quit'],['bot add\norder normal\n','eof']]) {
    const records=run(input);
    assert.equal(records.filter(e=>e.kind==='session-closed').length,1);
    assert.equal(records.at(-1).kind,'session-closed');assert.equal(records.at(-1).reason,reason);
    assert.equal(records.filter(e=>e.kind==='order-completed').length,0);
  }
});

test('finite --demo uses no stdin and reports simulated t0 through t40', () => {
  const records=run('', ['--demo']);
  assert.equal(records[0].kind,'run-started');assert.equal(records[0].anchor_utc,'12:00:00 UTC');
  assert.ok(records.every(e=>e.mode==='SIMULATED'));
  assert.equal(records.at(-1).kind,'run-summary');assert.equal(records.at(-1).elapsed_ns,'40000000000');
  assert.deepEqual(records.at(-1).snapshot.completed,[1002,1004,1001,1003]);
});

test('quit exits while the parent keeps the stdin pipe open', {timeout:4000}, async t => {
  const h=launchSession();t.after(()=>h.stop());
  await h.waitFor(o=>o.record.kind==='run-started',{timeout:2000});
  h.send('quit');
  await h.waitFor(o=>o.record.kind==='session-closed',{timeout:2000});
  const exit=await Promise.race([h.exit,new Promise((_,reject)=>{
    const timer=setTimeout(()=>reject(new Error('quit failed to release an open stdin pipe')),1500);
    timer.unref();
  })]);
  assert.equal(exit.code,0);assert.equal(exit.stderr,'');
});
