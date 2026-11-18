import { Readable } from 'node:stream';
import { getRecordingAudio } from '@cue/db';
import { BlobNotFoundError } from '@cue/storage';
import { parseRangeHeader } from '@/lib/http-range';
import { getBlobStore } from '@/server/blobs';
import { getDb } from '@/server/db';
import { getCurrentUser } from '@/server/session';

// Streams files from local disk: Node only.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/recordings/:id/audio: a recording's original audio, with HTTP Range
 * support so the browser's <audio> element can seek without downloading the
 * whole file (real-sales WAVs are about 150 MB each).
 *
 * - Signed out: 401. (Not a redirect like requireUser(): an <audio> element
 *   can't follow a sign-in page. Same check otherwise: cookie + user in the DB.)
 * - Recordings are a shared read-only library, so any signed-in user may play
 *   one. Datasets without a license (real-sales) stay behind login this way.
 * - Unknown id, no stored audio, or a missing file: 404, all the same.
 * - `Cache-Control: private, no-store`: never kept by shared caches or on disk.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return serveAudio(request, (await params).id, true);
}

export async function HEAD(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return serveAudio(request, (await params).id, false);
}

const BASE_HEADERS = {
  'Accept-Ranges': 'bytes',
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
};

function notFound(): Response {
  return Response.json({ error: 'not_found' }, { status: 404, headers: BASE_HEADERS });
}

/** Only serve audio types; anything else the importer recorded goes out as opaque bytes. */
function safeContentType(stored: string): string {
  return /^audio\/[a-z0-9.+-]+$/i.test(stored) ? stored : 'application/octet-stream';
}

async function serveAudio(request: Request, id: string, withBody: boolean): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: 'unauthorized' }, { status: 401, headers: BASE_HEADERS });
  }

  const audio = await getRecordingAudio(getDb(), id); // validates the id as a UUID
  if (!audio) return notFound();

  const blobs = getBlobStore();
  // The file's real size, not the imported row's: they must agree with what we stream.
  const info = await blobs.head(audio.storageKey);
  if (!info) return notFound();
  const size = info.bytes;
  const contentType = safeContentType(audio.contentType);

  const range = parseRangeHeader(request.headers.get('range'), size);
  if (range.kind === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { ...BASE_HEADERS, 'Content-Range': `bytes */${String(size)}` },
    });
  }

  const partial = range.kind === 'partial';
  const start = partial ? range.start : 0;
  const end = partial ? range.end : size - 1;
  const headers: Record<string, string> = {
    ...BASE_HEADERS,
    'Content-Type': contentType,
    'Content-Length': String(size === 0 ? 0 : end - start + 1),
  };
  if (partial) headers['Content-Range'] = `bytes ${String(start)}-${String(end)}/${String(size)}`;
  const status = partial ? 206 : 200;

  if (!withBody || size === 0) return new Response(null, { status, headers });

  let stream: Readable;
  try {
    stream = await blobs.get(audio.storageKey, partial ? { start, end } : undefined);
  } catch (err) {
    if (err instanceof BlobNotFoundError) return notFound(); // deleted between head and get
    throw err;
  }
  // If the browser cancels (e.g. it seeks elsewhere), the web stream is
  // cancelled and toWeb destroys the file stream, closing the file.
  const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
  return new Response(body, { status, headers });
}
