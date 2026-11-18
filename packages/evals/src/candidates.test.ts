import { describe, expect, it } from 'vitest';
import {
  candidateToCaseSkeleton,
  detectMoments,
  findCandidates,
  type ScanRecording,
} from './candidates';
import { parseCases } from './cases';

const cats = (text: string) => detectMoments(text).map((m) => m.category);

describe('detectMoments', () => {
  it.each([
    ["Honestly that's too expensive for a team our size.", 'price_objection'],
    ['Our budget for this year is already spent.', 'price_objection'],
    ['Can you just send me an email with the details?', 'send_email'],
    ['Can you send over some more information?', 'send_email'],
    ['Could you send me some information first?', 'send_email'],
    ["I'd need to run it by my CFO first.", 'stakeholder_approval'],
    ["I'd like to discuss this further with my team.", 'stakeholder_approval'],
    ['I still need to discuss this with my business partner.', 'stakeholder_approval'],
    ['I should show this to my boss and see what they think.', 'stakeholder_approval'],
    ['I still need to convince my team about the budget.', 'stakeholder_approval'],
    ["It's not my decision alone.", 'stakeholder_approval'],
    ['We already use HubSpot for that.', 'competitor'],
    ['Okay.', 'disengaged'],
    ["Look, I'm really busy today.", 'disengaged'],
    ['How soon can we get started?', 'buying_signal'],
    ['What are the next steps?', 'buying_signal'],
    ["It's kind of a mess, reporting takes forever.", 'vague_pain'],
  ])('%j → %s', (text, category) => {
    expect(cats(text)).toContain(category);
  });

  it.each([
    'Thanks, that makes sense.',
    'We have about forty people on the team.',
    'Okay, so what does the dashboard show?', // "okay" alone is disengaged; this is a question
    'The approver field is optional.'.replace('approver', 'reviewer'),
  ])('ignores the ordinary line %j', (text) => {
    expect(cats(text)).toEqual([]);
  });

  it('reports the matched text and can match several categories', () => {
    expect(detectMoments('Sounds great, but I need to check with my boss.')).toEqual([
      { category: 'stakeholder_approval', matched: 'check with my' },
      { category: 'buying_signal', matched: 'Sounds great' },
    ]);
  });
});

function rec(
  datasetId: string,
  externalId: string,
  lines: [string, 'rep' | 'prospect'][],
  license = 'apache-2.0',
): ScanRecording {
  return {
    datasetId,
    externalId,
    title: externalId,
    license,
    utterances: lines.map(([text, speaker], idx) => ({ idx, speaker, text })),
  };
}

const call = (n: number): [string, 'rep' | 'prospect'][] => [
  ['Hi, thanks for joining.', 'rep'],
  ['Sure.', 'prospect'],
  ['Let me show you pricing.', 'rep'],
  ...Array.from({ length: n }, (): [string, 'prospect'] => ["That's too expensive.", 'prospect']),
];

describe('findCandidates', () => {
  it('takes only prospect lines with enough context, ending the window at that line', () => {
    const [c] = findCandidates([rec('gwenshap/sales-transcripts', 't1', call(1))], {
      perCategory: 5,
    });
    expect(c).toMatchObject({
      category: 'price_objection',
      callId: 't1',
      utterances: [0, 3],
      window: [
        'Rep: Hi, thanks for joining.',
        'Prospect: Sure.',
        'Rep: Let me show you pricing.',
        "Prospect: That's too expensive.",
      ],
    });
    // "Sure." at position 1 has only one line before it: not enough context.
    expect(
      findCandidates([rec('d', 't1', call(1))], { perCategory: 5 }).map((x) => x.category),
    ).toEqual(['price_objection']);
  });

  it('caps the window at 12 utterances, like production', () => {
    const long: [string, 'rep' | 'prospect'][] = [
      ...Array.from({ length: 20 }, (_, i): [string, 'rep'] => [`line ${String(i)}`, 'rep']),
      ["That's too expensive.", 'prospect'],
    ];
    const [c] = findCandidates([rec('d', 'long', long)], { perCategory: 1 });
    expect(c?.window).toHaveLength(12);
    expect(c?.utterances).toEqual([9, 20]);
  });

  it('limits per call and per category, round-robin across datasets', () => {
    const recs = [
      rec('big/dataset', 'a', call(5)),
      rec('big/dataset', 'b', call(5)),
      rec('small/dataset', 'c', call(5)),
    ];
    const got = findCandidates(recs, { perCategory: 4, perCallPerCategory: 2 });
    expect(got.map((c) => `${c.dataset}:${c.callId}`)).toEqual([
      'big/dataset:a',
      'small/dataset:c',
      'big/dataset:a',
      'small/dataset:c',
    ]);
  });
});

describe('candidateToCaseSkeleton', () => {
  it('produces a valid DRAFT case, and leaves out unlicensed windows', () => {
    const [licensed] = findCandidates(
      [rec('gwenshap/sales-transcripts', 'transcript-1', call(1))],
      { perCategory: 1 },
    );
    const [unlicensed] = findCandidates(
      [rec('liva-ai/real-sales', 'conversation-2', call(1), 'unspecified')],
      {
        perCategory: 1,
      },
    );
    if (!licensed || !unlicensed) throw new Error('no candidates');
    const a = candidateToCaseSkeleton(licensed);
    const b = candidateToCaseSkeleton(unlicensed);
    expect(a).toMatchObject({
      id: 'price-objection-sales-transcripts-transcript-1-3',
      status: 'DRAFT',
    });
    expect(b.window).toBeNull();
    expect(parseCases([a, b].map((x) => JSON.stringify(x)).join('\n'))).toHaveLength(2);
  });
});
