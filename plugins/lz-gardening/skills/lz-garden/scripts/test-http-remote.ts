// A git remote served over HTTP that asks for one user and password on every request, as a private hosted repository
// does: git http-backend behind node:http. It runs in a child process, because a server in the test's own process
// cannot answer while the test waits in spawnSync for git.
import { spawn } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buffer } from 'node:stream/consumers';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './cli.ts';

// Serves the bare repositories in root and resolves to the port, once the server listens.
export function httpRemote(t: TestContext, root: string, credentials: string): Promise<string> {
  const server = spawn(process.execPath, [fileURLToPath(import.meta.url), root, credentials], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(() => {
    server.kill();
  });

  return new Promise((listening, failed) => {
    server.stdout.once('data', (port: unknown) => {
      listening(String(port).trim());
    });
    server.once('exit', (code) => {
      failed(new Error(`the HTTP remote exited with ${String(code)} before it listened`));
    });
  });
}

function serve(root: string, credentials: string): void {
  const expected = `Basic ${Buffer.from(credentials).toString('base64')}`;
  const server = createServer((request, response) => {
    if (request.headers.authorization !== expected) {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="remote"' });
      response.end();

      return;
    }

    backend(root, request, response);
  });
  server.listen(0, '127.0.0.1', () => {
    const address: AddressInfo | string | null = server.address();
    process.stdout.write(`${typeof address === 'object' && address !== null ? String(address.port) : ''}\n`);
  });
}

function backend(root: string, request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? '/', 'http://remote');
  const child = spawn('git', ['http-backend'], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: '1',
      // http-backend takes a push only from a user the server let in.
      REMOTE_USER: 'remote',
      REQUEST_METHOD: request.method ?? 'GET',
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: request.headers['content-type'] ?? '',
      HTTP_CONTENT_ENCODING: request.headers['content-encoding'] ?? '',
      GIT_PROTOCOL: request.headers['git-protocol']?.toString() ?? '',
    },
  });
  request.pipe(child.stdin);
  void buffer(child.stdout).then((output) => {
    const end = output.indexOf('\r\n\r\n');
    const fields = output
      .subarray(0, end)
      .toString()
      .split('\r\n')
      .map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()] as const);
    const status = fields.find(([name]) => name.toLowerCase() === 'status')?.[1];
    response.writeHead(
      status === undefined ? 200 : Number.parseInt(status, 10),
      Object.fromEntries(fields.filter(([name]) => name.toLowerCase() !== 'status')),
    );
    response.end(output.subarray(end + 4));
  });
}

if (isMainModule(import.meta.url)) {
  const [root = '', credentials = ''] = process.argv.slice(2);
  serve(root, credentials);
}
