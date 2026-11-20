// Local-only loader Worker: scripts/load_cloudflare.py posts batches of chunks to it while loading Vectorize.
// It is run with `npx wrangler dev` and never deployed.
//
// POST /embed  body: [{ chunk_id, pmid, text, pub_year, us_affiliation }, ...] (at most 1000)
// Embeds the texts with bge-base-en-v1.5, 100 at a time, then upserts them into Vectorize in one call
// (one large upsert stays under Vectorize's request rate limit). Returns { upserted }.
// Must be the same model the app uses to embed questions (EMBED_MODEL in worker/src/search.js).
const MODEL = '@cf/baai/bge-base-en-v1.5';

export default {
  async fetch(request, env) {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/embed') {
      return new Response('not found', { status: 404 });
    }
    const chunks = await request.json();
    const data = [];
    // Workers AI embeds at most 100 texts per call.
    for (let i = 0; i < chunks.length; i += 100) {
      const res = await env.AI.run(MODEL, { text: chunks.slice(i, i + 100).map((c) => c.text) });
      data.push(...res.data);
    }
    const vectors = chunks.map((c, i) => ({
      id: c.chunk_id,
      values: data[i],
      // Metadata indexes on pmid, pub_year and us_affiliation let a search filter on these later.
      metadata: { pmid: c.pmid, pub_year: c.pub_year ?? 0, us_affiliation: !!c.us_affiliation },
    }));
    await env.VECTORIZE.upsert(vectors);
    return Response.json({ upserted: vectors.length });
  },
};
