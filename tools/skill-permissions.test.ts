// Repository-only checks; nothing here ships with the plugin.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const skills = join(import.meta.dirname, '../plugins/lz-gardening/skills');

// A Read rule's single leading slash anchors at the working directory, so on Linux and macOS
// Read(${CLAUDE_SKILL_DIR}/**) expands to a path under the checkout and the skill cannot read its own files. The
// rule with one more slash is absolute there; the rule without it is the one that matches on Windows.
test('every Read rule on a plugin path in a skill has its absolute twin', () => {
  const missing = readdirSync(skills).flatMap((skill) => {
    const text = readFileSync(join(skills, skill, 'SKILL.md'), 'utf8');
    const rules = [...text.matchAll(/^ {2}- (Read\(\/?\$\{CLAUDE_[A-Z_]+\}[^)]*\))$/gm)].flatMap(
      ([, rule]) => rule ?? [],
    );

    return rules
      .filter((rule) => !rule.startsWith('Read(/'))
      .map((rule) => rule.replace('Read(', 'Read(/'))
      .filter((twin) => !rules.includes(twin))
      .map((twin) => `${skill}: ${twin}`);
  });

  assert.deepEqual(missing, []);
});
