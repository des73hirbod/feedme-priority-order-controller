import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {launchSession} from './live-harness.js';

async function save(name,evidence) {
  if(!process.env.FEEDME_EVIDENCE_DIR)return;
  await mkdir(process.env.FEEDME_EVIDENCE_DIR,{recursive:true});
  await writeFile(join(process.env.FEEDME_EVIDENCE_DIR,name),JSON.stringify(evidence,
    (_,value)=>typeof value==='bigint'?value.toString():value,2)+'\n');
}
function environment() {
  return {node:process.version,os:`${os.type()} ${os.release()} ${os.arch()}`,
    timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale:Intl.DateTimeFormat().resolvedOptions().locale,cpu:os.cpus()[0]?.model,
    loadavg:os.loadavg(),host_conditions:'No workload intentionally induced; normal desktop host. Windows loadavg is not a CPU-utilization measurement.',
    observer_clock:'External test-process process.hrtime.bigint()',watchdog_ms:30000};
}
function cpuTotals() {
  return os.cpus().reduce((sum,cpu)=>{
    const total=Object.values(cpu.times).reduce((a,b)=>a+b,0);
    return {total:sum.total+total,idle:sum.idle+cpu.times.idle};
  },{total:0,idle:0});
}

test('LIVE external process verification', {concurrency:2}, async t=>{
  await Promise.all([
    t.test('AT-A09 genuine no-early completion, idle stdin, unique result and clean quit', {timeout:35000}, async t=>{
      const h=launchSession();t.after(()=>h.stop());
      await h.waitFor(o=>o.record.kind==='run-started');
      h.send('bot add');await h.waitFor(o=>o.record.kind==='worker-added'&&o.record.worker_id===1);
      h.send('status');const idle=await h.waitFor(o=>o.record.kind==='status');
      assert.deepEqual(idle.record.snapshot.idle_workers,[1]);assert.equal(idle.record.snapshot.submitted,0);
      // This sample is immediately before the write; it never uses app timestamps.
      const cpuBefore=cpuTotals();
      const tPre=process.hrtime.bigint();h.send('order normal');
      const pickup=await h.waitFor(o=>o.record.kind==='order-started'&&o.record.order_id===1001);
      const complete=await h.waitFor(o=>o.record.kind==='order-completed'&&o.record.order_id===1001,
        {timeout:Math.max(1,30000-Number(process.hrtime.bigint()-tPre)/1e6)});
      assert.equal(pickup.record.worker_id,1);assert.equal(complete.record.worker_id,1);
      assert.equal(pickup.record.state,'PROCESSING');assert.equal(complete.record.state,'COMPLETE');
      assert.equal(typeof pickup.record.attempt_id,'string');assert.ok(pickup.record.attempt_id.length);
      assert.equal(complete.record.attempt_id,pickup.record.attempt_id);
      const duration=complete.seenNs-tPre;
      const cpuAfter=cpuTotals();
      assert.ok(duration>=10_000_000_000n,`Early external completion: ${duration}ns`);
      assert.ok(duration<=30_000_000_000n,`Watchdog exceeded: ${duration}ns`);
      assert.ok(pickup.seenNs<complete.seenNs);
      const from=h.observations.length;h.send('status');
      const status=await h.waitFor(o=>o.record.kind==='status',{after:from});
      assert.deepEqual(status.record.snapshot.completed,[1001]);assert.deepEqual(status.record.snapshot.idle_workers,[1]);
      h.send('quit');const exit=await h.exit;assert.deepEqual(exit,{code:0,signal:null,stderr:''});
      assert.equal(h.observations.filter(o=>o.record.kind==='order-completed').length,1);
      assert.ok(h.observations.every(o=>o.record.mode==='LIVE'));
      assert.equal(h.observations.at(-1).record.kind,'session-closed');
      const evidence={...environment(),t_pre_ns:tPre,pickup_seen_ns:pickup.seenNs,complete_seen_ns:complete.seenNs,
        pre_submit_to_completion_ns:duration,pickup_observed_to_completion_observed_ns:complete.seenNs-pickup.seenNs,
        host_cpu_busy_percent_during_observation:100*(1-(cpuAfter.idle-cpuBefore.idle)/(cpuAfter.total-cpuBefore.total)),
        no_early_completion:'PASS',watchdog:'PASS',exit,observations:h.observations};
      t.diagnostic(`AT-A09 external pre-submit→completion ${Number(duration)/1e9}s; watchdog PASS`);
      await save('LIVE_AT_A09.json',evidence);
    }),
    t.test('AT-09 AT-A01 live overlap and queued progress with no subsequent stdin', {timeout:35000}, async t=>{
      const h=launchSession();t.after(()=>h.stop());
      await h.waitFor(o=>o.record.kind==='run-started');
      h.send('order normal');h.send('order normal');h.send('order normal');h.send('bot add');h.send('bot add');
      const p1=await h.waitFor(o=>o.record.kind==='order-started'&&o.record.order_id===1001);
      const p2=await h.waitFor(o=>o.record.kind==='order-started'&&o.record.order_id===1002);
      assert.equal(p1.record.worker_id,1);assert.equal(p2.record.worker_id,2);
      const c1=await h.waitFor(o=>o.record.kind==='order-completed'&&o.record.order_id===1001);
      const c2=await h.waitFor(o=>o.record.kind==='order-completed'&&o.record.order_id===1002);
      assert.ok(p1.seenNs<c1.seenNs&&p2.seenNs<c1.seenNs);
      assert.ok(c2.seenNs>p1.seenNs);
      const c3=await h.waitFor(o=>o.record.kind==='order-completed'&&o.record.order_id===1003);
      const records=h.observations.map(o=>o.record);
      assert.deepEqual(records.filter(e=>e.kind==='order-completed').map(e=>e.order_id),[1001,1002,1003]);
      assert.equal(records.find(e=>e.kind==='order-started'&&e.order_id===1003).worker_id,1);
      // No line was sent between worker additions and completion of all three orders.
      h.send('quit');const exit=await h.exit;assert.equal(exit.code,0);assert.equal(exit.stderr,'');
      await save('LIVE_OVERLAP_AND_AUTONOMY.json',{...environment(),exit,third_complete_seen_ns:c3.seenNs,observations:h.observations});
    }),
  ]);
});
