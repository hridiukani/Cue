import { describe, expect, it } from 'vitest';
import {
  DISENGAGED_RUN_LENGTH,
  isShortProspectReply,
  PROSPECT_SKIP_MAX_WORDS,
  ProspectTrigger,
} from './prospect-trigger';

describe('isShortProspectReply (the skip rule)', () => {
  it(`treats at most ${String(PROSPECT_SKIP_MAX_WORDS)} words without a question mark as short`, () => {
    expect(PROSPECT_SKIP_MAX_WORDS).toBe(3);
    for (const t of ['yeah', 'mm-hmm', 'okay sure', 'yeah that makes', '', '  ']) {
      expect(isShortProspectReply(t)).toBe(true);
    }
  });

  it('treats more than 3 words as substantive', () => {
    expect(isShortProspectReply('yeah that makes sense')).toBe(false);
    expect(isShortProspectReply('honestly it is too expensive')).toBe(false);
  });

  it('never skips a question, however short', () => {
    for (const t of ['why?', 'how much?', 'is it?', 'really ?']) {
      expect(isShortProspectReply(t)).toBe(false);
    }
  });

  it('takes a custom word limit', () => {
    expect(isShortProspectReply('okay sure', 1)).toBe(false);
    expect(isShortProspectReply('okay', 1)).toBe(true);
  });
});

describe('ProspectTrigger', () => {
  it('triggers on substantive lines, as before', () => {
    const t = new ProspectTrigger();
    expect(t.decide('we spend hours matching invoices')).toEqual({
      kind: 'trigger',
      why: 'substantive',
    });
    expect(t.decide('and our ERP is old')).toEqual({ kind: 'trigger', why: 'substantive' });
  });

  it('skips an isolated short reply, with a reason', () => {
    const t = new ProspectTrigger();
    expect(t.decide('yeah')).toEqual({ kind: 'skip', reason: 'prospect_backchannel', run: 1 });
  });

  it(`triggers on ${String(DISENGAGED_RUN_LENGTH)} short replies in a row (disengagement)`, () => {
    expect(DISENGAGED_RUN_LENGTH).toBe(3);
    const t = new ProspectTrigger();
    expect(t.decide('yeah').kind).toBe('skip');
    expect(t.decide('sure').kind).toBe('skip');
    expect(t.decide('okay')).toEqual({ kind: 'trigger', why: 'disengaged' });
    expect(t.shortRun).toBe(0); // the next disengagement suggestion needs a full run again
    expect(t.decide('mm').kind).toBe('skip');
    expect(t.decide('right').kind).toBe('skip');
    expect(t.decide('fine')).toEqual({ kind: 'trigger', why: 'disengaged' });
  });

  it('resets the run when a longer line arrives', () => {
    const t = new ProspectTrigger();
    t.decide('yeah');
    t.decide('sure');
    expect(t.shortRun).toBe(2);
    expect(t.decide('what does onboarding look like for a team of ten')).toEqual({
      kind: 'trigger',
      why: 'substantive',
    });
    expect(t.shortRun).toBe(0);
    expect(t.decide('okay')).toEqual({ kind: 'skip', reason: 'prospect_backchannel', run: 1 });
  });

  it('a short question breaks the run and triggers', () => {
    const t = new ProspectTrigger();
    t.decide('yeah');
    t.decide('sure');
    expect(t.decide('how much?')).toEqual({ kind: 'trigger', why: 'substantive' });
    expect(t.shortRun).toBe(0);
  });

  it('takes custom thresholds', () => {
    const t = new ProspectTrigger({ maxShortWords: 1, disengagedRun: 2 });
    expect(t.decide('okay sure').kind).toBe('trigger'); // 2 words > 1
    expect(t.decide('okay').kind).toBe('skip');
    expect(t.decide('fine')).toEqual({ kind: 'trigger', why: 'disengaged' });
  });
});
