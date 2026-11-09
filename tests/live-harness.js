import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';

/** External observer: no controller imports or app clock access. */
export function launchSession() {
  const entry=fileURLToPath(new URL('../src/main.js',import.meta.url));
  const child=spawn(process.execPath,[entry],{stdio:['pipe','pipe','pipe']});
  const changes=new EventEmitter();
  const observations=[];
  let stderr='', failure=null, ended=false;
  child.stderr.setEncoding('utf8');child.stderr.on('data',data=>{stderr+=data;});
  child.on('error',error=>{failure=error;changes.emit('changed');});
  const lines=createInterface({input:child.stdout,crlfDelay:Infinity});
  lines.on('line',line=>{
    const seenNs=process.hrtime.bigint();
    try { observations.push({record:JSON.parse(line),seenNs}); }
    catch(error) { failure=error; }
    changes.emit('changed');
  });
  const exit=new Promise(resolve=>child.on('close',(code,signal)=>{
    ended=true;changes.emit('changed');resolve({code,signal,stderr});
  }));
  function waitFor(predicate,{after=0,timeout=30000}={}) {
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>finish(new Error(`Observer timeout ${timeout}ms; stderr=${stderr}`)),timeout);
      function finish(error,value) {
        clearTimeout(timer);changes.off('changed',check);
        if(error)reject(error);else resolve(value);
      }
      function check() {
        if(failure) return finish(failure);
        const found=observations.slice(after).find(predicate);
        if(found)return finish(null,found);
        if(ended)return finish(new Error(`Child exited before expected observation: ${stderr}`));
      }
      changes.on('changed',check);check();
    });
  }
  return {child,observations,exit,waitFor,send:command=>child.stdin.write(`${command}\n`),
    stop:()=>{if(!ended)child.kill();}};
}
