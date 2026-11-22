import type { PrismaClient } from '@infosound/database';
import { contentHash, passageText } from './embedder';
import { loadE5 } from './e5';

type Row = {
  id: string;
  title: string;
  description: string;
  source_version: number;
  lines: { text: string }[] | null;
  lyrics_version: number | null;
  content_hash: string | null;
  model: string | null;
};

/** Embeds every public track; rows whose content_hash (text + model id) is unchanged are skipped. */
export async function embedTracks(db: PrismaClient, opts: { force: boolean; log: (line: string) => void }): Promise<void> {
  const rows = await db.$queryRaw<Row[]>`
    SELECT t.id::text, t.title, t.description, t.source_version,
      l.lines, l.source_version AS lyrics_version, e.content_hash, e.model
    FROM tracks t
    JOIN users a ON a.id=t.author_id AND a.active=true
    LEFT JOIN track_lyrics l ON l.track_id=t.id
    LEFT JOIN track_embeddings e ON e.track_id=t.id
    WHERE t.publication_state='PUBLISHED' AND t.processing_state='READY' AND t.deleted_at IS NULL
    ORDER BY t.id`;
  const embedder = await loadE5();
  const todo = rows
    .map((r) => {
      const lyrics = r.lyrics_version === r.source_version && Array.isArray(r.lines) ? r.lines.map((x) => x.text) : [];
      const text = passageText({ title: r.title, description: r.description, lyrics });
      return { row: r, text, hash: contentHash(text, embedder.modelId) };
    })
    .filter((x) => opts.force || x.row.content_hash !== x.hash || x.row.model !== embedder.modelId);
  opts.log(`embed: ${rows.length} public tracks, ${todo.length} to (re)embed with ${embedder.modelId} (dims ${embedder.dims})`);
  for (let start = 0; start < todo.length; start += 64) {
    const chunk = todo.slice(start, start + 64);
    const vectors = await embedder.embed(chunk.map((x) => x.text)); // internally batched by 16
    await db.$transaction(async (tx) => {
      for (let i = 0; i < chunk.length; i += 1) {
        const { row, hash } = chunk[i];
        const vector = Array.from(vectors[i]);
        await tx.$executeRaw`
          INSERT INTO track_embeddings (track_id, source_version, content_hash, model, dims, vector, updated_at)
          VALUES (${row.id}::uuid, ${row.source_version}, ${hash}, ${embedder.modelId}, ${vector.length}, ${vector}::real[], now())
          ON CONFLICT (track_id) DO UPDATE SET source_version=EXCLUDED.source_version, content_hash=EXCLUDED.content_hash,
            model=EXCLUDED.model, dims=EXCLUDED.dims, vector=EXCLUDED.vector, updated_at=now()`;
      }
    });
    opts.log(`embed: ${Math.min(start + 64, todo.length)}/${todo.length}`);
  }
}
