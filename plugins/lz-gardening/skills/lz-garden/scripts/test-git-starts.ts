import childProcess from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const startsFile = process.env['LZ_GARDEN_GIT_STARTS'];

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
}
