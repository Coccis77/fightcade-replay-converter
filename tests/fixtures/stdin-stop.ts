// Run by tests/signals.test.ts in a real child process: `watch` waits for stdin to close,
// `dispose` stops watching at once (as fc2mp4 does after a conversion) and must let the process exit.
import { stopOnStdinClose } from '../../src/signals.js';

const controller = new AbortController();
const dispose = stopOnStdinClose(process.stdin, controller, (msg) => process.stderr.write(msg));
if (process.argv[2] === 'dispose') {
  dispose();
  process.stdout.write('disposed\n');
} else {
  controller.signal.addEventListener('abort', () => {
    process.stdout.write('aborted\n');
    dispose();
  });
}
