import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import { z } from 'zod';
import { type FetchFn, fetchWithRetry, HttpError, type SleepFn } from './http';

/**
 * Minimal Hugging Face client: dataset metadata (access, license, revision),
 * file listing and download, and the datasets-server rows/filter API. No SDK;
 * every response is validated with zod.
 */

const HUB = 'https://huggingface.co';
const DATASETS_SERVER = 'https://datasets-server.huggingface.co';
// Generic client name: never send anything identifying the user or project.
const USER_AGENT = 'cue-ingest/0.1';

const DatasetInfoSchema = z.object({
  sha: z.string(),
  gated: z.union([z.boolean(), z.string()]).optional(),
  private: z.boolean().optional(),
  cardData: z
    .object({ license: z.union([z.string(), z.array(z.string())]).optional() })
    .loose()
    .optional(),
});

const TreeSchema = z.array(
  z
    .object({ type: z.enum(['file', 'directory']), path: z.string(), size: z.number().optional() })
    .loose(),
);

const RowsResponseSchema = z.object({
  rows: z.array(z.object({ row: z.record(z.string(), z.unknown()) }).loose()),
  num_rows_total: z.number(),
});

export type ProbeResult =
  | { ok: true; revision: string; license: string; gated: boolean }
  | {
      ok: false;
      reason: 'not_found' | 'needs_token' | 'terms_not_accepted' | 'error';
      message: string;
    };

export interface TreeEntry {
  type: 'file' | 'directory';
  path: string;
  size: number | undefined;
}

export class HfClient {
  constructor(
    private readonly opts: { fetch: FetchFn; token?: string | undefined; sleep?: SleepFn },
  ) {}

  private headers(): Record<string, string> {
    return {
      'user-agent': USER_AGENT,
      ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}),
    };
  }

  private async get(url: string): Promise<Response> {
    return fetchWithRetry(
      this.opts.fetch,
      url,
      { headers: this.headers() },
      {
        ...(this.opts.sleep ? { sleep: this.opts.sleep } : {}),
      },
    );
  }

  private async getJson(url: string): Promise<unknown> {
    const res = await this.get(url);
    if (!res.ok) throw new HttpError(res.status, url);
    return res.json();
  }

  /**
   * Can we read this dataset? Returns its revision and license, or a reason
   * the user can act on (accept terms, set HF_TOKEN). Never throws for
   * 401/403/404.
   */
  async probe(datasetId: string): Promise<ProbeResult> {
    const page = `${HUB}/datasets/${datasetId}`;
    const res = await this.get(`${HUB}/api/datasets/${datasetId}`);
    if (res.status === 404) {
      return {
        ok: false,
        reason: 'not_found',
        message: `${datasetId} does not exist (or was removed): ${page}`,
      };
    }
    if (res.status === 401 || res.status === 403) return this.accessDenied(datasetId, res.status);
    if (!res.ok)
      return {
        ok: false,
        reason: 'error',
        message: `HTTP ${String(res.status)} from Hugging Face`,
      };

    const info = DatasetInfoSchema.parse(await res.json());
    const gated = info.gated !== undefined && info.gated !== false;
    if (gated || info.private) {
      // Metadata of gated datasets is public; the files are not. Check them.
      const files = await this.get(`${HUB}/api/datasets/${datasetId}/tree/${info.sha}`);
      if (files.status === 401 || files.status === 403)
        return this.accessDenied(datasetId, files.status);
      if (!files.ok)
        return {
          ok: false,
          reason: 'error',
          message: `HTTP ${String(files.status)} listing files`,
        };
    }
    const license = info.cardData?.license;
    return {
      ok: true,
      revision: info.sha,
      license: (Array.isArray(license) ? license.join(', ') : license) ?? 'unspecified',
      gated,
    };
  }

  private accessDenied(datasetId: string, status: number): ProbeResult {
    const page = `${HUB}/datasets/${datasetId}`;
    if (!this.opts.token) {
      return {
        ok: false,
        reason: 'needs_token',
        message:
          `${datasetId} is private, gated or missing (HTTP ${String(status)}). If it's gated: ` +
          `accept its terms at ${page}, create a read token at ${HUB}/settings/tokens, ` +
          'and set HF_TOKEN in .env.',
      };
    }
    return {
      ok: false,
      reason: 'terms_not_accepted',
      message:
        `Your HF_TOKEN can't read ${datasetId} (HTTP ${String(status)}). ` +
        `Accept the dataset's terms at ${page} with the same account, then retry.`,
    };
  }

  async listTree(datasetId: string, revision: string, dir: string): Promise<TreeEntry[]> {
    const url = `${HUB}/api/datasets/${datasetId}/tree/${revision}/${encodePath(dir)}`;
    return TreeSchema.parse(await this.getJson(url)).map((e) => ({
      type: e.type,
      path: e.path,
      size: e.size,
    }));
  }

  async fileText(datasetId: string, revision: string, filePath: string): Promise<string> {
    const url = resolveUrl(datasetId, revision, filePath);
    const res = await this.get(url);
    if (!res.ok) throw new HttpError(res.status, url);
    return res.text();
  }

  async fileStream(datasetId: string, revision: string, filePath: string): Promise<Readable> {
    const url = resolveUrl(datasetId, revision, filePath);
    const res = await this.get(url);
    if (!res.ok || !res.body) throw new HttpError(res.status, url);
    return Readable.fromWeb(res.body as NodeWebReadableStream<Uint8Array>);
  }

  /**
   * One page of rows from the datasets-server. With `where`, uses the /filter
   * endpoint (SQL-like condition), otherwise /rows.
   */
  async rows(
    datasetId: string,
    q: { config: string; split: string; offset: number; length: number; where?: string },
  ): Promise<{ rows: Record<string, unknown>[]; total: number }> {
    const params = new URLSearchParams({
      dataset: datasetId,
      config: q.config,
      split: q.split,
      offset: String(q.offset),
      length: String(q.length),
      ...(q.where ? { where: q.where } : {}),
    });
    const endpoint = q.where ? 'filter' : 'rows';
    const json = RowsResponseSchema.parse(
      await this.getJson(`${DATASETS_SERVER}/${endpoint}?${params.toString()}`),
    );
    return { rows: json.rows.map((r) => r.row), total: json.num_rows_total };
  }
}

function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

function resolveUrl(datasetId: string, revision: string, filePath: string): string {
  return `${HUB}/datasets/${datasetId}/resolve/${revision}/${encodePath(filePath)}`;
}
