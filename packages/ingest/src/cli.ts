import { parseArgs } from 'node:util';
import { createDb } from '@cue/db';
import { loadRootEnvFile } from '@cue/db/node';
import { LocalFsBlobStore } from '@cue/storage';
import { realSalesAdapter } from './adapters/real-sales';
import { gwenshapAdapter } from './adapters/gwenshap';
import { saasAdapter } from './adapters/saas';
import { loadIngestConfig } from './config';
import { HfClient } from './hf-client';
import { LICENSED_DATASETS, localOnlyViolation } from './local-only';
import { runIngest } from './run';
import type { AdapterKey, DatasetAdapter } from './types';

const ADAPTERS: Record<AdapterKey, DatasetAdapter> = {
  'real-sales': realSalesAdapter,
  gwenshap: gwenshapAdapter,
  saas: saasAdapter,
};

const USAGE = `Usage: pnpm ingest -- --dataset <name> [options]

  --dataset <name>   real-sales | gwenshap | saas | licensed | all  (repeatable)
                     licensed = the Apache-2.0 ones (gwenshap + saas): what a deployment imports.
                     real-sales (no stated license) only goes into a database on this machine.
  --limit <n>        max recordings per dataset (default: saas 300, others all)
  --max-scan <n>     max rows to scan when filtering locally (default 3000)
  --with-audio       also download original audio (real-sales, ~1 GB) into ./data/blobs
  --dry-run          parse and report, write nothing
  --help

Set HF_TOKEN in .env for gated or private datasets.`;

async function main(): Promise<number> {
  // pnpm forwards a literal "--" when called as `pnpm ingest -- --dataset x`.
  const argv = process.argv.slice(2).filter((a, i) => !(i === 0 && a === '--'));
  const { values } = parseArgs({
    args: argv,
    options: {
      dataset: { type: 'string', multiple: true },
      limit: { type: 'string' },
      'max-scan': { type: 'string' },
      'with-audio': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help || !values.dataset?.length) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }

  const names = values.dataset.flatMap((d) =>
    d === 'all' ? Object.keys(ADAPTERS) : d === 'licensed' ? [...LICENSED_DATASETS] : [d],
  );
  const unknown = names.filter((n) => !(n in ADAPTERS));
  if (unknown.length) {
    console.error(`Unknown dataset(s): ${unknown.join(', ')}\n\n${USAGE}`);
    return 1;
  }
  const positiveInt = (v: string | undefined, flag: string): number | null => {
    if (v === undefined) return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} must be a positive integer`);
    return n;
  };

  loadRootEnvFile();
  const config = loadIngestConfig();
  const refused = localOnlyViolation(names, config.databaseUrl);
  if (refused) {
    console.error(refused);
    return 1;
  }
  const { db, close } = createDb(config.databaseUrl);
  try {
    const summaries = await runIngest({
      adapters: [...new Set(names)].map((n) => ADAPTERS[n as AdapterKey]),
      hf: new HfClient({ fetch: (url, init) => fetch(url, init), token: config.hfToken }),
      db,
      blobs: values['with-audio'] ? new LocalFsBlobStore(config.blobStoreDir) : null,
      limit: positiveInt(values.limit, '--limit'),
      maxScan: positiveInt(values['max-scan'], '--max-scan') ?? 3000,
      withAudio: values['with-audio'],
      dryRun: values['dry-run'],
      log: {
        info: (m) => {
          console.log(m);
        },
        warn: (m) => {
          console.warn(`warning: ${m}`);
        },
      },
    });

    console.log('\nSummary');
    for (const s of summaries) {
      console.log(
        `  ${s.dataset}: ${s.status}${s.license ? ` (license: ${s.license})` : ''} · ` +
          `${String(s.imported)} imported · ${String(s.skipped.length)} skipped · ${String(s.failed.length)} failed`,
      );
      if (s.message) console.log(`    ${s.message}`);
      for (const k of s.skipped.slice(0, 5))
        console.log(`    skipped ${k.externalId}: ${k.reason}`);
      for (const f of s.failed.slice(0, 5)) console.log(`    FAILED ${f.externalId}: ${f.error}`);
    }
    return summaries.some((s) => s.failed.length > 0) ? 1 : 0;
  } finally {
    await close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  },
);
