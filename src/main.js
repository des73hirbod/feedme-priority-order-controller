import {createInterface} from 'node:readline';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createController} from './controller.js';
import {createRuntime} from './runtime.js';
import {parseCommand} from './cli.js';
import {createFormatter} from './log.js';
import {runDemo} from './demo.js';

export async function main(args = process.argv.slice(2)) {
  if (args.length && (args.length !== 1 || args[0] !== '--demo')) {
    process.stderr.write('Usage: node src/main.js [--demo]\n');
    process.exitCode = 2;
    return;
  }
  const mode = args[0] === '--demo' ? 'SIMULATED' : 'LIVE';
  const format = createFormatter({mode});
  const emit = event => process.stdout.write(`${format(event)}\n`);
  if (mode === 'SIMULATED') { runDemo(emit); return; }

  const controller = createController();
  const runtime = createRuntime({controller,emit});
  emit({kind:'run-started',logicalTimeNs:0n,session:'interactive'});
  const reader = createInterface({input:process.stdin,terminal:false,crlfDelay:Infinity});
  await new Promise((resolveClose, reject) => {
    reader.on('line', line => {
      if (runtime.isClosed()) return;
      try {
        runtime.accept(parseCommand(line));
        if (runtime.isClosed()) reader.close();
      } catch (error) { reader.close(); reject(error); }
    });
    reader.on('close', () => {
      try {
        if (!runtime.isClosed()) runtime.accept({op:'eof'});
        // readline.close() only pauses its input. A still-open Windows pipe
        // can keep the process alive after quit; release our finished reader.
        process.stdin.destroy();
        resolveClose();
      } catch (error) { reject(error); }
    });
    reader.on('error', reject);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
