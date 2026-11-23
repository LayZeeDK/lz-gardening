// Repository-only checks; nothing here ships with the plugin.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const skills = join(import.meta.dirname, '../plugins/lz-gardening/skills');

// A Read rule's single leading slash anchors at the working directory, so on Linux and macOS
// Read(${CLAUDE_SKILL_DIR}/**) expands to a path under the checkout and the skill cannot read its own files. The
// rule with one more slash is absolute there; the rule without it is the one that matches on Windows.
test('every Read rule on a plugin path in a skill comes in both forms', () => {
  const rules = readdirSync(skills, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap(({ name }) =>
      [
        ...(/^---\n([\s\S]*?)\n---$/m.exec(readFileSync(join(skills, name, 'SKILL.md'), 'utf8'))?.[1] ?? '').matchAll(
          /Read\(\/?\$\{CLAUDE_[A-Z_]+\}[^)]*\)/g,
        ),
      ].map(([rule]) => `${name}: ${rule}`),
    );
  const missing = rules
    .map((rule) => (rule.includes('Read(/') ? rule.replace('Read(/', 'Read(') : rule.replace('Read(', 'Read(/')))
    .filter((twin) => !rules.includes(twin));

  assert.notDeepEqual(rules, []);
  assert.deepEqual(missing, []);
});
