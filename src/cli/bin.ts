import { main } from './main';

// node:sqlite prints an ExperimentalWarning on Node 22. Warnings are delivered on the next tick,
// so a filter installed here still catches the one raised while the modules above were loading.
const defaultListeners = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && warning.message.includes('SQLite')) return;
  for (const listener of defaultListeners) listener.call(process, warning);
});

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
