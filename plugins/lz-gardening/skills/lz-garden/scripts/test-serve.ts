// Servers a test points git at. Each runs as a script in a child process, because a server in the test's own process
// cannot answer while the test waits in spawnSync for git.
import { spawn } from 'node:child_process';
import type { TestContext } from 'node:test';

const silentServerCloseMs = 15_000;

// Takes the connection and never answers, until it closes it.
export const silentServer = `require("node:net").createServer((s) => { s.on("error", () => {}); setTimeout(() => s.destroy(), ${String(silentServerCloseMs)}); }).listen(0, "127.0.0.1", function () { process.stdout.write(String(this.address().port)); });`;

// Runs the script, which writes the port it listens on, and resolves to that port. The script writes it with
// process.stdout.write: console.log colors a number when FORCE_COLOR is set, as Nx sets it for every task.
export function serve(t: TestContext, script: string): Promise<string> {
  const server = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => {
    server.kill();
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.stdout.setEncoding('utf8');
    server.stdout.once('data', (chunk: string) => {
      resolve(chunk.trim());
    });
    server.once('exit', (code) => {
      reject(new Error(`the server exited with ${String(code)} before it listened`));
    });
  });
}
