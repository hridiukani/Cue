import { describe, expect, it } from 'vitest';
import { describeFile, parseGwenshapTranscript } from './gwenshap';
import { parseRealSalesTranscript, parseTimestamp } from './real-sales';
import { parseSaasConversation, saasRowToItem } from './saas';

describe('gwenshap', () => {
  it('parses labeled turns, joining continuation lines', () => {
    const r = parseGwenshapTranscript(
      [
        '**Sales Rep**: Hi there! Thanks for',
        'taking the time.',
        '',
        '**Customer**: Hi Jamie. Doing well.',
      ].join('\n'),
    );
    expect(r).toEqual({
      ok: true,
      turns: [
        { speaker: 'rep', text: 'Hi there! Thanks for taking the time.' },
        { speaker: 'prospect', text: 'Hi Jamie. Doing well.' },
      ],
    });
  });

  it('skips a transcript with an unknown speaker rather than guessing', () => {
    expect(parseGwenshapTranscript('**Narrator**: x\n**Customer**: y')).toEqual({
      ok: false,
      reason: 'unknown speaker label "Narrator"',
    });
  });

  it('derives id, company and index from the file name', () => {
    expect(describeFile('data/transcripts/nexiv-solutions__3_transcript.txt')).toEqual({
      externalId: 'nexiv-solutions__3',
      company: 'Nexiv Solutions',
      index: 3,
    });
  });
});

describe('real-sales', () => {
  const transcript = [
    'Conversation 1 Transcript',
    '========================================',
    '',
    '[0:01 - 0:50] Seller:',
    'Hello, Alex. It is nice to meet you.',
    '',
    '[0:52 - 0:54] Partner:',
    'Hey, Arjun. Um, you can hear me okay?',
    '',
    '[0:55 - 0:55] Seller:',
    'I can.',
    '',
    '[1:01:02 - 1:01:05] Partner:',
    'Much later.',
  ].join('\n');

  it('parses m:ss and h:mm:ss timestamps', () => {
    expect(parseTimestamp('0:52')).toBe(52_000);
    expect(parseTimestamp('1:01:02')).toBe(3_662_000);
  });

  it('parses timed blocks, treating the end second as inclusive', () => {
    const r = parseRealSalesTranscript(transcript);
    if (!r.ok) throw new Error(r.reason);
    expect(r.turns.map((t) => [t.speaker, t.startedMs, t.endedMs, t.text])).toEqual([
      ['rep', 1000, 50_999, 'Hello, Alex. It is nice to meet you.'],
      ['prospect', 52_000, 54_999, 'Hey, Arjun. Um, you can hear me okay?'],
      ['rep', 55_000, 55_999, 'I can.'],
      ['prospect', 3_662_000, 3_665_999, 'Much later.'],
    ]);
    expect(r.reordered + r.repaired).toBe(0);
  });

  it('fails clearly when there are no timestamped blocks', () => {
    expect(parseRealSalesTranscript('just text').ok).toBe(false);
  });
});

describe('saas', () => {
  const conversation = JSON.stringify([
    { speaker: 'customer', message: 'hey, quick q...' },
    { speaker: 'sales_rep', message: 'totally get that!' },
  ]);
  const row = {
    conversation_id: 'saas-7-conv-0',
    company_name: 'AutoTest Pro',
    product_name: 'TestMaster Suite',
    product_type: 'Professional Services',
    communication_channel: 'phone_call',
    conversation_style: 'skeptical_challenging',
    conversation_flow: 'multi_session',
    outcome: 1,
    conversation,
    // Present in the real rows; must never be stored.
    scenario: JSON.stringify({ customer_persona: { name: 'Jessica Martinez' } }),
    embedding_0: 0.123,
  };

  it('parses the JSON conversation', () => {
    expect(parseSaasConversation(conversation)).toEqual({
      ok: true,
      turns: [
        { speaker: 'prospect', text: 'hey, quick q...' },
        { speaker: 'rep', text: 'totally get that!' },
      ],
    });
  });

  it('turns a phone row into a recording with allowlisted metadata only', () => {
    const item = saasRowToItem(row);
    expect(item).toMatchObject({
      kind: 'recording',
      recording: {
        externalId: 'saas-7-conv-0',
        title: 'TestMaster Suite · AutoTest Pro',
        timing: 'estimated',
        metadata: {
          product_type: 'Professional Services',
          conversation_style: 'skeptical_challenging',
          conversation_flow: 'multi_session',
          communication_channel: 'phone_call',
          outcome: 1,
        },
      },
    });
    const meta = item?.kind === 'recording' ? item.recording.metadata : {};
    expect(Object.keys(meta)).not.toContain('scenario');
    expect(JSON.stringify(meta)).not.toContain('Jessica');
  });

  it('ignores non-phone channels and skips malformed conversations', () => {
    expect(saasRowToItem({ ...row, communication_channel: 'sms' })).toBeNull();
    expect(saasRowToItem({ ...row, conversation: '{not json' })).toMatchObject({ kind: 'skip' });
  });
});
