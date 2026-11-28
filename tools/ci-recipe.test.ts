// Repository-only checks; nothing here ships with the plugin.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..');

test("the README's CI recipe is the workflow this repository runs", () => {
  const workflow = readFileSync(join(root, '.github/workflows/garden.yml'), 'utf8');
  const readme = readFileSync(join(root, 'plugins/tometo/README.md'), 'utf8');

  const recipe = /^```yaml\n(name: garden\n[\s\S]*?)^```$/m.exec(readme)?.[1];

  assert.equal(recipe, workflow);
});

test("the workflow's --tools names every tool the gardener agent uses", () => {
  const workflow = readFileSync(join(root, '.github/workflows/garden.yml'), 'utf8');
  const agent = readFileSync(join(root, 'plugins/tometo/agents/gardener.md'), 'utf8');

  const tools = /^ +claude_args: .*--tools (\S+)/m.exec(workflow)?.[1]?.split(',') ?? [];
  const agentTools = /^tools: (.+)$/m.exec(agent)?.[1]?.split(', ') ?? [];

  assert.notDeepEqual(agentTools, []);
  assert.deepEqual(
    agentTools.filter((tool) => !tools.includes(tool)),
    [],
  );
});
