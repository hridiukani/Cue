import {
  CoachingNotesSchema,
  NextStepsSchema,
  PlaybookObjectionsSchema,
  RaisedObjectionsSchema,
} from '@cue/shared';

/**
 * Demo data for local development. "Tallyforge" and every company and person
 * here are fictional.
 *
 * The latency timestamps in DEMO_SUGGESTIONS are invented for the demo. They
 * are NOT measurements and must never be quoted as Cue's performance. They are
 * labelled with model 'seed-fixture' so they're easy to exclude.
 */

export const DEMO_USER = { email: 'demo@cue.local', name: 'Demo Rep' } as const;

export const DEMO_PLAYBOOK = {
  name: 'Tallyforge: mid-market AP outbound',
  productDescription:
    'Tallyforge automates accounts-payable reconciliation. It reads incoming invoices, matches each line to the purchase order and goods receipt (three-way match), flags mismatches for review, and syncs approved bills to the ERP. Typical customers cut manual invoice handling by more than half.',
  idealCustomer:
    'Finance teams at companies with 200–2,000 employees processing 1,500+ supplier invoices a month on NetSuite, Sage Intacct or Microsoft Dynamics, still matching invoices in spreadsheets. Buyer: Controller or VP Finance; champion: AP manager.',
  objections: PlaybookObjectionsSchema.parse([
    {
      objection: 'We already have AP built into our ERP.',
      good_response:
        'Most ERPs store the invoice but leave the matching to people. Ask how many invoices a week still need someone to compare lines by hand.',
    },
    {
      objection: 'It is too expensive for us right now.',
      good_response:
        'Anchor on the cost of the current process: hours per week on matching times loaded salary, plus late-payment fees and missed early-pay discounts.',
    },
    {
      objection: 'We tried automation before and it created more exceptions.',
      good_response:
        'Acknowledge it. Ask what broke. Tallyforge lets them set match tolerances per supplier and starts in review-only mode, so nothing posts without a person approving it.',
    },
    {
      objection: 'Now is not a good time; we are in the middle of month-end close.',
      good_response:
        'Respect the timing. Offer a 20-minute look after close and ask what next month-end would need to look like for this to be worth it.',
    },
  ]),
  toneNotes:
    'Consultative and plain-spoken. Ask before telling. Never disparage their ERP. Keep suggestions to one sentence.',
} as const;

export const DEMO_CALL = {
  title: 'Discovery: Halvorsen Supply Co.',
  startedAt: new Date('2026-11-10T15:00:00.000Z'),
  endedAt: new Date('2026-11-10T15:14:30.000Z'),
  status: 'ended',
} as const;

/** Final utterances. started_ms / ended_ms are ms since the call started. */
export const DEMO_UTTERANCES = [
  {
    speaker: 'rep',
    text: 'Thanks for making time today. How are you handling supplier invoices right now?',
    startedMs: 2_000,
    endedMs: 6_400,
    confidence: 0.97,
  },
  {
    speaker: 'prospect',
    text: 'Honestly, mostly spreadsheets. NetSuite holds the bills, but my team matches them against POs by hand.',
    startedMs: 7_100,
    endedMs: 13_800,
    confidence: 0.94,
  },
  {
    speaker: 'rep',
    text: 'How many invoices is that in a typical month?',
    startedMs: 14_600,
    endedMs: 16_900,
    confidence: 0.98,
  },
  {
    speaker: 'prospect',
    text: 'Around two thousand. Month-end is brutal; two people basically do nothing else for a week.',
    startedMs: 17_500,
    endedMs: 23_200,
    confidence: 0.95,
  },
  {
    speaker: 'rep',
    text: 'That sounds painful. What happens when a line does not match the PO?',
    startedMs: 24_000,
    endedMs: 27_600,
    confidence: 0.96,
  },
  {
    speaker: 'prospect',
    text: 'It sits in someone’s inbox until they chase the buyer. We paid a few late fees last quarter because of that.',
    startedMs: 28_300,
    endedMs: 35_100,
    confidence: 0.92,
  },
  {
    speaker: 'rep',
    text: 'Tallyforge does that three-way match automatically and only sends you the exceptions.',
    startedMs: 36_000,
    endedMs: 40_500,
    confidence: 0.97,
  },
  {
    speaker: 'prospect',
    text: 'We tried an automation tool two years ago and it flagged everything. It made more work, not less.',
    startedMs: 41_200,
    endedMs: 47_900,
    confidence: 0.93,
  },
  {
    speaker: 'rep',
    text: 'What made it flag so much? Was it price differences, quantities, something else?',
    startedMs: 49_100,
    endedMs: 53_400,
    confidence: 0.95,
  },
  {
    speaker: 'prospect',
    text: 'Freight charges mostly. Suppliers add shipping that was never on the PO.',
    startedMs: 54_000,
    endedMs: 58_700,
    confidence: 0.94,
  },
  {
    speaker: 'rep',
    text: 'You can set a tolerance per supplier, so a freight line under a threshold just passes.',
    startedMs: 59_500,
    endedMs: 64_200,
    confidence: 0.96,
  },
  {
    speaker: 'prospect',
    text: 'Okay, that would help. But I would need my controller to see the numbers before anything moves.',
    startedMs: 65_000,
    endedMs: 71_300,
    confidence: 0.93,
  },
] as const;

/**
 * Suggestions, each triggered by the prospect utterance at `utteranceIndex`.
 * Offsets are ms after that utterance ended. INVENTED VALUES (see top).
 */
export const DEMO_SUGGESTIONS = [
  {
    utteranceIndex: 3,
    text: 'Ask what those two people would work on if month-end took two days instead of a week.',
    offsets: { requestSent: 18, firstToken: 290, lastToken: 540, clientRendered: 585 },
    feedback: ['used', 'thumbs_up'],
  },
  {
    utteranceIndex: 7,
    text: 'Acknowledge that, then ask what specifically it flagged.',
    offsets: { requestSent: 21, firstToken: 310, lastToken: 505, clientRendered: 560 },
    feedback: ['used'],
  },
  {
    utteranceIndex: 11,
    text: 'Offer to build a one-page cost comparison the controller can review.',
    offsets: { requestSent: 16, firstToken: 335, lastToken: 610, clientRendered: 650 },
    feedback: ['ignored'],
  },
] as const;

export const DEMO_SEED_MODEL = 'seed-fixture';
export const DEMO_PROMPT_VERSION = 'seed-v0';

export const DEMO_SUMMARY = {
  summary:
    'Halvorsen Supply matches ~2,000 NetSuite invoices a month by hand; two AP staff spend most of month-end on it and late fees hit last quarter. A past automation tool over-flagged freight lines. Prospect is interested in per-supplier tolerances but needs the controller to review numbers first.',
  objectionsRaised: RaisedObjectionsSchema.parse([
    {
      objection: 'A previous automation tool created more exceptions than it removed.',
      rep_response: 'Asked what it flagged, then explained per-supplier tolerances for freight.',
      handled: true,
    },
    {
      objection: 'Controller has to approve before anything changes.',
      rep_response: null,
      handled: false,
    },
  ]),
  nextSteps: NextStepsSchema.parse([
    {
      action: 'Send a one-page cost comparison for the controller',
      owner: 'rep',
      due: '2026-11-13',
    },
    { action: 'Share a sample of last month’s freight exceptions', owner: 'prospect' },
  ]),
} as const;

/** Coaching notes; `utteranceIndex` is resolved to a real utterance id when seeding. */
export const DEMO_COACHING_NOTES = [
  { note: 'Good follow-up on volume: it quantified the pain early.', utteranceIndex: 2 },
  {
    note: 'Pitched the feature before exploring the late-fee impact; ask one more question first.',
    utteranceIndex: 6,
  },
  { note: 'Did not respond to the controller concern before the call ended.' },
] as const;

// Validate the coaching-note shape too (ids are filled in at seed time).
CoachingNotesSchema.parse(DEMO_COACHING_NOTES.map(({ note }) => ({ note })));
