import childProcess from 'node:child_process';
import { subscribe } from 'node:diagnostics_channel';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { gitStartChannel } from './store-git-reader.ts';

const startsFile = process.env['_LZ_GARDENING_INTERNAL_GIT_STARTS'];

if (startsFile !== undefined) {
  Object.defineProperty(childProcess, 'spawnSync', {
    value: new Proxy(childProcess.spawnSync, {
      apply(target, thisArg, args: unknown[]) {
        const [command, commandArgs] = args;

        if (command === 'git') {
          appendFileSync(startsFile, `git ${Array.isArray(commandArgs) ? commandArgs.join(' ') : ''}\n`);
        }

        const result: unknown = Reflect.apply(target, thisArg, args);

        return result;
      },
    }),
  });
  syncBuiltinESMExports();
  // A reader's git starts in a worker thread, where this module does not run; the reader tells the start here.
  subscribe(gitStartChannel, (message) => {
    const args = typeof message === 'object' && message !== null && 'args' in message ? message.args : [];
    appendFileSync(startsFile, `git ${Array.isArray(args) ? args.join(' ') : ''}\n`);
  });
}
