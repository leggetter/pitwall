// The pitwall skill's text (W209): the link line before a spin-off block, and no repeated blocks.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const skill = readFileSync(new URL('../../plugin/skills/pitwall/SKILL.md', import.meta.url), 'utf8');

describe('plugin/skills/pitwall/SKILL.md', () => {
  it('asks for a link line just before the block, from the pitwall note, and none without a note', () => {
    expect(skill).toContain('Start it in pitwall: <pitwall URL>/?session=<your session id>&spinoff=latest');
    expect(skill).toMatch(/Just before the block/);
    expect(skill).toMatch(/no pitwall note, write no line/);
  });

  it('tells the session not to repeat a proposal to keep its card', () => {
    expect(skill).toMatch(/don't repeat a proposal in a later message/);
  });
});
