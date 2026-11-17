import { publicConfig } from '@/config';

export default function HomePage() {
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-2 p-8">
      <h1 className="text-2xl font-semibold">Cue</h1>
      <p className="text-neutral-600">Real-time sales-call coach. Nothing here yet.</p>
      <p className="text-sm text-neutral-500">
        Realtime service: <code>{publicConfig.realtimeUrl}</code>
      </p>
    </main>
  );
}
