import { describe, expect, it } from 'vitest';
import {
  CoachingNotesSchema,
  RecordingMetadataSchema,
  NextStepsSchema,
  PlaybookObjectionsSchema,
  RaisedObjectionsSchema,
} from './db-json';

describe('PlaybookObjectionsSchema', () => {
  it('accepts a list of objection/response pairs', () => {
    const value = [{ objection: 'Too expensive', good_response: 'Compare it to the cost of…' }];
    expect(PlaybookObjectionsSchema.parse(value)).toEqual(value);
  });

  it('rejects empty strings and unknown keys', () => {
    expect(
      PlaybookObjectionsSchema.safeParse([{ objection: '', good_response: 'x' }]).success,
    ).toBe(false);
    expect(
      PlaybookObjectionsSchema.safeParse([{ objection: 'a', good_response: 'b', extra: 1 }])
        .success,
    ).toBe(false);
  });
});

describe('RaisedObjectionsSchema', () => {
  it('allows a null rep_response for unanswered objections', () => {
    expect(
      RaisedObjectionsSchema.safeParse([
        { objection: 'Timing', rep_response: null, handled: false },
      ]).success,
    ).toBe(true);
  });
});

describe('NextStepsSchema', () => {
  it('accepts an optional ISO date', () => {
    expect(
      NextStepsSchema.safeParse([
        { action: 'Send pricing', owner: 'rep', due: '2026-11-20' },
        { action: 'Loop in CFO', owner: 'prospect' },
      ]).success,
    ).toBe(true);
  });

  it('rejects an unknown owner or a malformed date', () => {
    expect(NextStepsSchema.safeParse([{ action: 'x', owner: 'manager' }]).success).toBe(false);
    expect(
      NextStepsSchema.safeParse([{ action: 'x', owner: 'rep', due: 'next week' }]).success,
    ).toBe(false);
  });
});

describe('CoachingNotesSchema', () => {
  it('requires utterance_id to be a uuid when present', () => {
    expect(CoachingNotesSchema.safeParse([{ note: 'Good discovery question' }]).success).toBe(true);
    expect(CoachingNotesSchema.safeParse([{ note: 'x', utterance_id: 'abc' }]).success).toBe(false);
  });
});

describe('RecordingMetadataSchema', () => {
  it('accepts small flat metadata', () => {
    expect(
      RecordingMetadataSchema.safeParse({ product_type: 'SaaS', outcome: 1, converted: true })
        .success,
    ).toBe(true);
  });

  it.each([
    'seller_age_range',
    'partner_gender',
    'seller_ethnicity',
    'partner_grew_up_in',
    'Race',
    'sellerGrewUpIn',
    'partnerAgeRange',
  ])('refuses the demographic key %s', (key) => {
    expect(RecordingMetadataSchema.safeParse({ [key]: 'x' }).success).toBe(false);
  });

  it.each(['language', 'stage', 'message_count', 'page', 'usage_tier', 'grewth'])(
    'allows the ordinary key %s',
    (key) => {
      expect(RecordingMetadataSchema.safeParse({ [key]: 'x' }).success).toBe(true);
    },
  );

  it('refuses nested objects', () => {
    expect(RecordingMetadataSchema.safeParse({ scenario: { persona: 'x' } }).success).toBe(false);
  });
});
