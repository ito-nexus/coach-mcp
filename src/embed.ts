// Turns a search question into a vector with the same model n8n used for the chunks.
import { config } from './config.js';

export async function embed(text: string): Promise<number[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${config.openaiBaseUrl}/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.openaiApiKey}` },
        body: JSON.stringify({ model: config.embedModel, input: text }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        const body = await res.text();
        // Retry only on rate limits and server errors.
        if (res.status === 429 || res.status >= 500) throw new Error(`Embedding request failed (${res.status}): ${body.slice(0, 200)}`);
        throw Object.assign(new Error(`Embedding request failed (${res.status}): ${body.slice(0, 200)}`), { fatal: true });
      }
      const json = (await res.json()) as { data: { embedding: number[] }[] };
      const vec = json.data?.[0]?.embedding;
      if (!Array.isArray(vec)) throw new Error('Embedding response had no vector');
      return vec;
    } catch (e) {
      lastError = e;
      if ((e as { fatal?: boolean }).fatal) break;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastError;
}
