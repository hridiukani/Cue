import { WINDOW_SIZE } from '@cue/suggest';
import type { Category } from './cases';

/**
 * Finds candidate eval moments in imported calls: a PROSPECT line that looks
 * like one of the categories (a price objection, "send me an email", …), with
 * the WINDOW_SIZE utterances ending at it as the conversation. These are only
 * candidates: a person reviews them, keeps the good ones and writes rubrics.
 */

interface Detector {
  /** Any match makes the line a candidate; the matched text is reported. */
  patterns: RegExp[];
}

const w = (s: string) => new RegExp(`\\b(?:${s})\\b`, 'i');

export const DETECTORS: Record<Category, Detector> = {
  price_objection: {
    patterns: [
      w(
        "too expensive|pricey|over (?:our|the) budget|out of (?:our|my) budget|can'?t afford|cheaper|costs? too much|that'?s a lot of money|price is (?:too )?high|price point",
      ),
      w('budget(?:s|ed)? (?:is|are|was|for this|this year)|tight budget|no budget'),
    ],
  },
  send_email: {
    patterns: [
      w(
        '(?:can|could|would) you (?:just )?send|send (?:me|us|over|it over)(?: some| more| the)?(?: more)?(?: detailed)? (?:an? )?(?:email|e-mail|info|information|details|something|deck|proposal|materials|brochure)|email me|shoot me an email|(?:in|by|over) (?:an )?email|send it over',
      ),
    ],
  },
  stakeholder_approval: {
    patterns: [
      w(
        '(?:run|bring|show) (?:it|this|that) (?:by|to|past)|(?:check|discuss|talk|go over|review) (?:this |it |that |about this )?(?:further |more )?with (?:my|our|the)|talk to (?:my|our) (?:boss|manager|team|cfo|ceo|partner|director|vp)|convince (?:my|our)|my (?:boss|manager|business partner|partner|cfo|ceo|director|vp)\\b|sign[- ]off|approv(?:e|al)|decision[- ]makers?|not (?:my|just my) (?:call|decision)|the board|procurement|legal (?:team|review)',
      ),
    ],
  },
  competitor: {
    patterns: [
      w(
        '(?:already|currently) (?:use|using|have|work with)|we use|switch(?:ing)? from|your competitors?|another (?:vendor|provider|tool|company)|other (?:vendors|providers|tools|options)|(?:salesforce|hubspot|zendesk|quickbooks|netsuite|xero|oracle|sap)',
      ),
    ],
  },
  disengaged: {
    patterns: [
      /^(?:ok(?:ay)?|sure|fine|yeah|yep|maybe|i guess|not really|hm+|mm+|uh[- ]huh|right|whatever|no)[.!?…]*$/i,
      w(
        "(?:i'?m|we'?re) (?:really )?busy|not (?:really )?interested|don'?t have (?:much )?time|not a priority|bad time|in a hurry|have to (?:run|go|jump)",
      ),
    ],
  },
  buying_signal: {
    patterns: [
      w(
        'how (?:soon|quickly) can|when can (?:we|you) (?:start|get started|begin)|next steps?|(?:a |free )?trial|pilot|onboarding|implementation|how do (?:we|i) get started|sign (?:up|the contract)|contract|what would it take|sounds (?:great|good|interesting)|that would (?:really )?help',
      ),
    ],
  },
  vague_pain: {
    patterns: [
      w(
        "(?:kind|sort) of (?:a )?(?:problem|issue|pain|mess|struggle)|(?:a bit|a little) (?:of a )?(?:problem|issue|challenge|messy|slow)|struggl(?:e|ing)|frustrat(?:ed|ing)|it'?s (?:been )?(?:hard|tough|difficult)|could be better|not ideal|some issues|challenges?",
      ),
    ],
  },
};

export interface MomentMatch {
  category: Category;
  matched: string;
}

/** Every category this prospect line looks like, with the text that matched. */
export function detectMoments(text: string): MomentMatch[] {
  const out: MomentMatch[] = [];
  const trimmed = text.trim();
  for (const [category, d] of Object.entries(DETECTORS) as [Category, Detector][]) {
    for (const p of d.patterns) {
      const m = p.exec(trimmed);
      if (m) {
        out.push({ category, matched: m[0] });
        break;
      }
    }
  }
  return out;
}

export interface ScanRecording {
  datasetId: string;
  externalId: string;
  title: string;
  license: string;
  utterances: { idx: number; speaker: 'rep' | 'prospect'; text: string }[];
}

export interface Candidate {
  category: Category;
  matched: string;
  dataset: string;
  license: string;
  callId: string;
  title: string;
  /** Inclusive [first, last] utterance indexes; last is the prospect line. */
  utterances: [number, number];
  /** "Rep: …"/"Prospect: …" lines, oldest first. */
  window: string[];
}

const label = (s: 'rep' | 'prospect') => (s === 'rep' ? 'Rep' : 'Prospect');

/**
 * Candidates across all recordings: at most `perCategory` per category,
 * picked round-robin across datasets (so one big dataset can't crowd out the
 * others) and at most `perCallPerCategory` from any one call. A moment needs
 * at least `minContext` utterances before it, or there's nothing to react to.
 */
export function findCandidates(
  recordings: readonly ScanRecording[],
  opts: { perCategory: number; perCallPerCategory?: number; minContext?: number },
): Candidate[] {
  const perCall = opts.perCallPerCategory ?? 2;
  const minContext = opts.minContext ?? 2;
  // category → dataset → candidates in call order
  const pools = new Map<Category, Map<string, Candidate[]>>();
  for (const rec of recordings) {
    const used = new Map<Category, number>();
    const ordered = [...rec.utterances].sort((a, b) => a.idx - b.idx);
    ordered.forEach((u, pos) => {
      if (u.speaker !== 'prospect' || pos < minContext) return;
      for (const m of detectMoments(u.text)) {
        if ((used.get(m.category) ?? 0) >= perCall) continue;
        used.set(m.category, (used.get(m.category) ?? 0) + 1);
        const slice = ordered.slice(Math.max(0, pos - WINDOW_SIZE + 1), pos + 1);
        const first = slice[0]?.idx ?? u.idx;
        const byDataset = pools.get(m.category) ?? new Map<string, Candidate[]>();
        pools.set(m.category, byDataset);
        const list = byDataset.get(rec.datasetId) ?? [];
        byDataset.set(rec.datasetId, list);
        list.push({
          category: m.category,
          matched: m.matched,
          dataset: rec.datasetId,
          license: rec.license,
          callId: rec.externalId,
          title: rec.title,
          utterances: [first, u.idx],
          window: slice.map((x) => `${label(x.speaker)}: ${x.text}`),
        });
      }
    });
  }
  const out: Candidate[] = [];
  for (const byDataset of pools.values()) {
    const queues = [...byDataset.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, l]) => [...l]);
    let taken = 0;
    while (taken < opts.perCategory && queues.some((q) => q.length > 0)) {
      for (const q of queues) {
        const c = q.shift();
        if (c && taken < opts.perCategory) {
          out.push(c);
          taken++;
        }
      }
    }
  }
  return out;
}

/** A case skeleton for a candidate, ready to paste into cases.jsonl and edit. */
export function candidateToCaseSkeleton(c: Candidate): Record<string, unknown> {
  const short = c.dataset.split('/').at(-1) ?? c.dataset;
  return {
    id: `${c.category.replace(/_/g, '-')}-${short}-${c.callId}-${String(c.utterances[1])}`
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .slice(0, 64),
    status: 'DRAFT',
    category: c.category,
    smoke: false,
    source: { dataset: c.dataset, license: c.license, callId: c.callId, utterances: c.utterances },
    playbook: 'none',
    // Never copy a window from a dataset without a license into the repo.
    window: c.license === 'unspecified' ? null : c.window,
    rubric: { must: ['TODO: what a good next line must do'], mustNot: [], bannedPhrases: [] },
    notes: `candidate: matched "${c.matched}"`,
  };
}
