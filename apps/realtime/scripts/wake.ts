import { parseArgs } from 'node:util';
import { isAwake, wake } from '../src/wake';

// Usage: pnpm wake -- --realtime wss://<service>.onrender.com [--web https://<app>.vercel.app]
const argv = process.argv.slice(2).filter((a, i) => !(i === 0 && a === '--'));
const { values } = parseArgs({
  args: argv,
  options: { realtime: { type: 'string' }, web: { type: 'string' } },
  strict: true,
});
if (!values.realtime) {
  console.error(
    'Usage: pnpm wake -- --realtime wss://<service>.onrender.com [--web https://<app>.vercel.app]',
  );
  process.exit(1);
}

const report = await wake(
  { realtime: values.realtime, web: values.web ?? null },
  {
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (line) => {
      console.log(line);
    },
  },
);
console.log(isAwake(report) ? '\nEverything is awake.' : '\nNot everything is awake (see above).');
process.exitCode = isAwake(report) ? 0 : 1;
