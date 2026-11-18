import { describe, expect, it } from 'vitest';
import { parseCases } from './cases';
import { type LoadUtterances, parsePlaybooks, resolveCase } from './resolve';

const PLAYBOOKS = parsePlaybooks(
  JSON.stringify({
    acme: {
      name: 'Acme',
      status: 'DRAFT',
      productDescription: 'Invoice matching',
      idealCustomer: 'Finance teams',
      objections: [{ objection: 'Too expensive', good_response: 'Compare to manual cost' }],
      toneNotes: null,
    },
  }),
);

function kase(over: Record<string, unknown> = {}) {
  const [c] = parseCases(
    JSON.stringify({
      id: 'case-01',
      status: 'DRAFT',
      category: 'price_objection',
      source: {
        dataset: 'liva-ai/real-sales',
        license: 'unspecified',
        callId: 'conversation-3',
        utterances: [4, 6],
      },
      playbook: 'none',
      window: null,
      rubric: { must: ['x'] },
      ...over,
    }),
  );
  if (!c) throw new Error('no case');
  return c;
}

const utterances = [
  { idx: 3, speaker: 'rep' as const, text: 'hello' },
  { idx: 4, speaker: 'prospect' as const, text: 'hi' },
  { idx: 5, speaker: 'rep' as const, text: 'it is 400' },
  { idx: 6, speaker: 'prospect' as const, text: 'too much' },
  { idx: 7, speaker: 'rep' as const, text: 'later' },
];
const loader: LoadUtterances = (dataset, callId) =>
  Promise.resolve(
    dataset === 'liva-ai/real-sales' && callId === 'conversation-3' ? utterances : null,
  );

describe('resolveCase', () => {
  it('loads a database window by dataset, call id and utterance range', async () => {
    const r = await resolveCase(kase(), PLAYBOOKS, loader);
    expect(r).toMatchObject({
      ok: true,
      resolved: {
        window: [
          { speaker: 'prospect', text: 'hi' },
          { speaker: 'rep', text: 'it is 400' },
          { speaker: 'prospect', text: 'too much' },
        ],
        playbook: null,
        playbookText: null,
      },
    });
  });

  it('attaches the playbook and the text the model sees', async () => {
    const r = await resolveCase(kase({ playbook: 'acme' }), PLAYBOOKS, loader);
    expect(r.ok && r.resolved.playbookText).toContain('Product: Invoice matching');
  });

  it.each([
    ['no database', kase(), null, /not connected/],
    [
      'call not imported',
      kase({
        source: {
          dataset: 'liva-ai/real-sales',
          license: 'unspecified',
          callId: 'conversation-9',
          utterances: [0, 1],
        },
      }),
      loader,
      /not imported here/,
    ],
    [
      'range missing',
      kase({
        source: {
          dataset: 'liva-ai/real-sales',
          license: 'unspecified',
          callId: 'conversation-3',
          utterances: [6, 9],
        },
      }),
      loader,
      /not found/,
    ],
    [
      'data changed',
      kase({
        source: {
          dataset: 'liva-ai/real-sales',
          license: 'unspecified',
          callId: 'conversation-3',
          utterances: [4, 5],
        },
      }),
      loader,
      /no longer ends with the prospect/,
    ],
    ['unknown playbook', kase({ playbook: 'zzz' }), loader, /unknown playbook/],
  ])('skips with a reason when: %s', async (_name, c, load, reason) => {
    const r = await resolveCase(c, PLAYBOOKS, load);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(reason);
  });
});

describe('parsePlaybooks', () => {
  it('rejects the reserved "none" key and malformed playbooks', () => {
    expect(() => parsePlaybooks(JSON.stringify({ none: {} }))).toThrow();
    expect(() => parsePlaybooks(JSON.stringify({ acme: { name: 'x' } }))).toThrow(
      /Invalid playbooks/,
    );
  });
});
