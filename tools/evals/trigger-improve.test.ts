import assert from 'node:assert/strict';
import { test } from 'node:test';
import { improvePrompt, parseDescription } from './trigger-improve.ts';

function result(query: string, shouldTrigger: boolean, triggers: number, pass: boolean) {
  return { query, should_trigger: shouldTrigger, triggers, runs: 3, trigger_rate: triggers / 3, pass };
}

test('improvePrompt lists the misses, the false triggers and earlier attempts by train score, never by test score', () => {
  const train = {
    results: [result('tend the suppressions', true, 0, false), result('explain worktrees', false, 2, false)],
    summary: { passed: 0, failed: 2, total: 2 },
  };
  const prompt = improvePrompt({
    skillName: 'tend',
    skillContent: 'BODY OF THE SKILL',
    current: 'Tend one class.',
    train,
    history: [{ description: 'Old try.', train }],
  });
  const fragments = [
    '<current_description>\n"Tend one class."\n</current_description>',
    'Current scores (Train: 0/2):',
    'FAILED TO TRIGGER (should have triggered but didn\'t):\n  - "tend the suppressions" (triggered 0/3 times)',
    'FALSE TRIGGERS (triggered but shouldn\'t have):\n  - "explain worktrees" (triggered 2/3 times)',
    '<attempt train=0/2>\nDescription: "Old try."',
    '<skill_content>\nBODY OF THE SKILL\n</skill_content>',
  ];

  assert.deepEqual(
    fragments.filter((fragment) => !prompt.includes(fragment)),
    [],
  );
  assert.doesNotMatch(prompt, /test=/);
  assert.ok(prompt.endsWith('Respond with only the new description text in <new_description> tags, nothing else.'));
});

test('parseDescription takes the tagged text without quotes, or the whole reply when it has no tags', () => {
  assert.deepEqual(
    [
      parseDescription('Sure.\n<new_description>\n"Use for weeds."\n</new_description>'),
      parseDescription(' "Plain." '),
    ],
    ['Use for weeds.', 'Plain.'],
  );
});
