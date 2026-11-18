# Datasets

Cue replays recorded sales calls through the realtime pipeline. The recordings come from public Hugging Face datasets, imported into Postgres with `pnpm ingest`.

**No dataset files are committed to this repository.** Everything the importer downloads goes into your local database. Audio goes to `./data/blobs`, which is gitignored along with `*.wav`, `*.pcm`, `*.mp3` and `*.flac`.

## Datasets

| `--dataset`  | Hugging Face dataset                                                                                                         | License                     | What's imported                                                                | Timing    |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------ | --------- |
| `real-sales` | [liva-ai/real-sales](https://huggingface.co/datasets/liva-ai/real-sales)                                                     | **none stated** (see below) | 7 unscripted calls: timed transcripts, plus original audio with `--with-audio` | real      |
| `gwenshap`   | [gwenshap/sales-transcripts](https://huggingface.co/datasets/gwenshap/sales-transcripts)                                     | apache-2.0                  | 51 simulated calls (text only)                                                 | estimated |
| `saas`       | [DeepMostInnovations/saas-sales-conversations](https://huggingface.co/datasets/DeepMostInnovations/saas-sales-conversations) | apache-2.0                  | synthetic SaaS dialogues, **phone calls only** (300 by default)                | estimated |

**"Estimated" timing:**

- The dataset has no timestamps, so the importer spaces turns out at about 160 words per minute, with a 600 ms pause between speakers.
- These recordings are marked `timing = 'estimated'`, and the UI shows a badge.

**Not imported:** `liva-ai/mock-sales` no longer exists on Hugging Face.

### ⚠️ real-sales has no stated license

The `liva-ai/real-sales` dataset card doesn't state a license. Without one, we have no explicit permission to redistribute or publicly display its content. Therefore:

- **Its transcripts and audio must stay behind login in any public deployment.** The app already requires sign-in for every page, including the call library, and the audio route (`/api/recordings/:id/audio`) answers 401 to signed-out requests. Don't add public or shareable views of these recordings, and don't publish them in demos, screenshots or exports.
- Use it for local development and evaluation only.
- Revisit this if the publisher adds a license.

The importer prints a warning, and stores `license = 'unspecified'` in the `datasets` table.

### Privacy: what is _not_ imported

real-sales also publishes each speaker's **age range, gender, ethnicity and where they grew up** (in `data/metadata.csv` and the datasets-server rows). **Cue never imports or stores these.**

- The real-sales adapter reads only `transcripts/*.txt` and the file listing. It never requests `metadata.csv` or the rows API. Tests assert this.
- Every adapter copies metadata from an explicit allowlist, such as product type and outcome for saas.
- The database layer also rejects any metadata key that looks demographic (`RecordingMetadataSchema`).
- The saas dataset's `scenario` field holds invented persona names. It isn't stored either.

## Running the importer (PowerShell)

```powershell
docker compose up -d
pnpm db:migrate

pnpm ingest -- --dataset gwenshap            # ~51 small files, seconds
pnpm ingest -- --dataset real-sales          # transcripts only (no audio download)
pnpm ingest -- --dataset saas --limit 50     # see "saas download size" below
pnpm ingest -- --dataset all
pnpm ingest -- --help
```

**Options:**

| Flag               | Meaning                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| `--dataset <name>` | `real-sales`, `gwenshap`, `saas` or `all`. Can be repeated.                                                   |
| `--limit <n>`      | Maximum recordings per dataset. Defaults to 300 for saas and everything for the others.                       |
| `--max-scan <n>`   | Maximum source rows to scan when filtering locally. Default 3000.                                             |
| `--with-audio`     | Also download the original audio. real-sales only, about 1 GB: seven stereo 48 kHz WAVs of about 150 MB each. |
| `--dry-run`        | Parse and report; write nothing.                                                                              |

**Re-running is safe.** Recordings are matched by `(dataset, external id)` and updated in place. Replay sessions you've already run keep their own saved utterances.

### saas download size

The source CSV is 7.2 GB, almost all of it embeddings, so the importer never downloads it. Instead it pages through the Hugging Face datasets-server API:

- It first asks the server to filter to phone calls.
- If that endpoint is unavailable (it has been intermittent), it scans pages of 100 rows and filters locally. Each page is about 12 MB because of the embeddings, and only about 15% of rows are phone calls. So 300 phone calls means scanning about 2,000 rows, about 240 MB. `--max-scan` caps this.

## Gated or private datasets (HF_TOKEN)

None of the datasets above is gated today. If one becomes gated, or you add a gated dataset:

1. Sign in to Hugging Face and **accept the dataset's terms** on its page.
2. Create a **read** token at <https://huggingface.co/settings/tokens>.
3. Put it in `.env`: `HF_TOKEN=hf_...`. **Never commit it.**

Without access, the importer **skips that dataset** with a message that says which of these steps is missing, and imports the rest.

## Storage

Imported audio goes through the `BlobStore` interface (`packages/storage`). The only implementation today is `LocalFsBlobStore`, which writes to `BLOB_STORE_DIR` (default `./data/blobs`).

- Keys look like `liva-ai/real-sales/conversation-1.wav`.
- An S3-compatible store can implement the same interface later, without changing the importer.
- Audio is stored **unprocessed**. Speech-to-text is a later step.
- The web app reads the same `BLOB_STORE_DIR`. If it's unset, the default is `../../data/blobs` relative to the folder Next runs in, which is `apps/web` under `pnpm dev`.

## Audio playback in the replay

A recording with stored audio plays its audio on the replay page. See docs/latency.md, "Audio playback", for how the audio stays on the transcript's timeline.

- **The route:** `GET /api/recordings/:id/audio` streams the original file.
- **Range requests:** with a single `Range: bytes=…` it answers 206 and exactly those bytes, so `<audio>` seeks without downloading the roughly 150 MB file. A range past the end gets 416. Several ranges, or a malformed header, get the whole file (200).
- **Who can get it:** signed-out requests get 401. Unknown ids, recordings without stored audio, and files missing from the store all get the same 404.
- **Caching:** `Cache-Control: private, no-store`, so shared caches and the disk cache don't keep it.
- **Audio not downloaded:** recordings imported without `--with-audio` show an "Audio not downloaded" badge and replay as transcript only.
