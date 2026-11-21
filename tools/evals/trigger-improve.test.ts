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
    skillName: 'lz-tend',
    skillContent: 'BODY OF THE SKILL',
    current: 'Tend one class.',
    train,
    history: [{ description: 'Old try.', train, testPassed: 1, testTotal: 2 }],
  });

  assert.deepEqual(
    [
      prompt.includes('<current_description>\n"Tend one class."\n</current_description>'),
      prompt.includes('Current scores (Train: 0/2):'),
      prompt.includes(
        'FAILED TO TRIGGER (should have triggered but didn\'t):\n  - "tend the suppressions" (triggered 0/3 times)',
      ),
      prompt.includes('FALSE TRIGGERS (triggered but shouldn\'t have):\n  - "explain worktrees" (triggered 2/3 times)'),
      prompt.includes('<attempt train=0/2>\nDescription: "Old try."'),
      prompt.includes('test='),
      prompt.includes('<skill_content>\nBODY OF THE SKILL\n</skill_content>'),
      prompt.endsWith('Respond with only the new description text in <new_description> tags, nothing else.'),
    ],
    [true, true, true, true, true, false, true, true],
  );
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
