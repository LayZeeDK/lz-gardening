// The prompt that asks a model for a better skill description, and the parser for its answer. Adapted from
// skill-creator's improve_description.py (claude-plugins-official, Apache License 2.0); changes: TypeScript, the call
// itself left to the caller, earlier attempts carry train scores only. Repository-only; nothing here ships with the
// plugin.
import type { Results } from './trigger-results.ts';

export interface Attempt {
  readonly description: string;
  readonly train: Results;
}

export interface ImproveInput {
  readonly skillName: string;
  readonly skillContent: string;
  readonly current: string;
  readonly train: Results;
  readonly history: readonly Attempt[];
}

function score({ summary }: Results): string {
  return `${String(summary.passed)}/${String(summary.total)}`;
}

function listed(heading: string, results: Results['results']): string {
  if (results.length === 0) {
    return '';
  }

  const lines = results.map(
    (result) => `  - "${result.query}" (triggered ${String(result.triggers)}/${String(result.runs)} times)`,
  );

  return `${heading}\n${lines.join('\n')}\n\n`;
}

function attempt({ description, train }: Attempt): string {
  const lines = train.results.map(
    (result) =>
      `  [${result.pass ? 'PASS' : 'FAIL'}] "${result.query.slice(0, 80)}" (triggered ${String(result.triggers)}/${String(result.runs)})`,
  );

  return `<attempt train=${score(train)}>\nDescription: "${description}"\nTrain results:\n${lines.join('\n')}\n</attempt>\n\n`;
}

// Earlier attempts show their train scores only, so the test set stays unseen by the model that writes descriptions.
export function improvePrompt({ skillName, skillContent, current, train, history }: ImproveInput): string {
  const failed = train.results.filter((result) => result.should_trigger && !result.pass);
  const falseTriggers = train.results.filter((result) => !result.should_trigger && !result.pass);
  const attempts =
    history.length === 0
      ? ''
      : `PREVIOUS ATTEMPTS (do NOT repeat these — try something structurally different):\n\n${history.map(attempt).join('')}`;

  return `You are optimizing a skill description for a Claude Code skill called "${skillName}". A "skill" is sort of like a prompt, but with progressive disclosure -- there's a title and description that Claude sees when deciding whether to use the skill, and then if it does use the skill, it reads the .md file which has lots more details and potentially links to other resources in the skill folder like helper files and scripts and additional documentation or examples.

The description appears in Claude's "available_skills" list. When a user sends a query, Claude decides whether to invoke the skill based solely on the title and on this description. Your goal is to write a description that triggers for relevant queries, and doesn't trigger for irrelevant ones.

Here's the current description:
<current_description>
"${current}"
</current_description>

Current scores (Train: ${score(train)}):
<scores_summary>
${listed("FAILED TO TRIGGER (should have triggered but didn't):", failed)}${listed("FALSE TRIGGERS (triggered but shouldn't have):", falseTriggers)}${attempts}</scores_summary>

Skill content (for context on what the skill does):
<skill_content>
${skillContent}
</skill_content>

Based on the failures, write a new and improved description that is more likely to trigger correctly. Don't overfit to the specific cases you're seeing: don't produce an ever-expanding list of queries this skill should or shouldn't trigger for. Generalize from the failures to broader categories of user intent and situations where this skill would be useful or not useful, because the description is injected into every query next to many other skills.

Keep the description to about 100-200 words, even at some cost in accuracy. There is a hard limit of 1024 characters; stay comfortably under it.

Tips that work well:
- Phrase it in the imperative: "Use this skill for" rather than "this skill does".
- Focus on the user's intent, what they are trying to achieve, not on how the skill works.
- The description competes with other skills for Claude's attention: make it distinctive and immediately recognizable.
- After repeated failures, change things up: try different sentence structures or wordings.

Mix up the style across iterations; the highest-scoring description is kept at the end.

Respond with only the new description text in <new_description> tags, nothing else.`;
}

export const maxDescription = 1024;

// One fresh call that quotes the too-long description and asks for a rewrite under the limit.
export function shortenPrompt(prompt: string, description: string): string {
  return `${prompt}

---

A previous attempt produced this description, which at ${String(description.length)} characters is over the ${String(maxDescription)}-character hard limit:

"${description}"

Rewrite it to be under ${String(maxDescription)} characters while keeping the most important trigger words and intent coverage. Respond with only the new description in <new_description> tags.`;
}

function unquoted(text: string): string {
  return text.trim().replace(/^"+|"+$/g, '');
}

export function parseDescription(text: string): string {
  const tagged = /<new_description>([\s\S]*?)<\/new_description>/.exec(text);

  return unquoted(tagged?.[1] ?? text);
}
