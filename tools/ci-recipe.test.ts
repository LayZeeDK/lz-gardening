// Repository-only checks; nothing here ships with the plugin.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test("the README's CI recipe is the workflow this repository runs, with the marketplace named by its URL", () => {
  const workflow = readFileSync(join(root, '.github/workflows/garden.yml'), 'utf8');
  const readme = readFileSync(join(root, 'plugins/lz-gardening/README.md'), 'utf8');

  const recipe = /^```yaml\n(name: garden\n[\s\S]*?)^```$/m.exec(readme)?.[1];

  assert.equal(
    recipe,
    workflow.replace(
      /^( +plugin_marketplaces: )\.\/$/m,
      (_line, key: string) => `${key}https://github.com/LayZeeDK/lz-gardening.git`,
    ),
  );
});
