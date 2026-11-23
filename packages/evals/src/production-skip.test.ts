import { DISENGAGED_RUN_LENGTH, PROSPECT_SKIP_MAX_WORDS, type WindowUtterance } from '@cue/suggest';
import { describe, expect, it } from 'vitest';
import { productionWouldSkip } from './production-skip';

const rep = (text: string): WindowUtterance => ({ speaker: 'rep', text });
const prospect = (text: string): WindowUtterance => ({ speaker: 'prospect', text });

describe('productionWouldSkip (same rule as production, from @cue/suggest)', () => {
  it('uses the production constants, not a copy', () => {
    // If production changes them, this report follows automatically.
    expect(PROSPECT_SKIP_MAX_WORDS).toBe(3);
    expect(DISENGAGED_RUN_LENGTH).toBe(3);
  });

  it('flags a case ending on an isolated short prospect reply', () => {
    expect(
      productionWouldSkip([
        rep('so that is how we price it'),
        prospect('we spend hours on invoices'),
        rep('and it scales with volume'),
        prospect('mm'),
      ]),
    ).toBe(true);
  });

  it("doesn't flag a substantive final line", () => {
    expect(
      productionWouldSkip([rep('any questions'), prospect('honestly it is too expensive for us')]),
    ).toBe(false);
  });

  it("doesn't flag a short question", () => {
    expect(productionWouldSkip([rep('it is 400 a month'), prospect('per seat?')])).toBe(false);
  });

  it("doesn't flag the third short reply in a row (production triggers: disengagement)", () => {
    expect(
      productionWouldSkip([
        rep('does that make sense'),
        prospect('yeah'),
        rep('and the setup is quick'),
        prospect('sure'),
        rep('want to see a demo'),
        prospect('okay'),
      ]),
    ).toBe(false);
  });

  it('flags a short reply after a longer line reset the run', () => {
    expect(
      productionWouldSkip([
        prospect('yeah'),
        prospect('sure'),
        prospect('we tried a tool before and it failed'),
        rep('what went wrong'),
        prospect('okay'),
      ]),
    ).toBe(true);
  });

  it('is false for a window without prospect lines', () => {
    expect(productionWouldSkip([rep('hello')])).toBe(false);
  });
});
