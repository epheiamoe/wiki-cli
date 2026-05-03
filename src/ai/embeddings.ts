import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface EmbeddingConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
}

interface CacheData {
  _model: string;
  _generated: string;
  [slug: string]: number[] | string;
}

let embeddingCache: { data: Record<string, number[]>; model: string; wikiPath: string } | null = null;

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export async function getEmbedding(text: string, config: EmbeddingConfig): Promise<number[]> {
  const url = `${config.baseUrl.replace(/\/+$/, '')}/embeddings`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({ model: config.model, input: text }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Embedding API error ${response.status}: ${err}`);
  }

  const result = await response.json();
  return result.data[0].embedding;
}

export async function computePageEmbeddings(
  wikiPath: string,
  config: EmbeddingConfig,
  pageFiles: string[]
): Promise<Record<string, number[]>> {
  const result: Record<string, number[]> = {};
  for (const file of pageFiles) {
    try {
      const content = await readFile(join(wikiPath, file), 'utf-8');
      const slug = file.replace(/\.md$/, '');
      result[slug] = await getEmbedding(content.slice(0, 8000), config);
    } catch {
      // skip pages that fail
    }
  }
  return result;
}

export interface SearchResult {
  slug: string;
  score: number;
}

export async function semanticSearch(
  query: string,
  wikiPath: string,
  config: EmbeddingConfig,
  pageFiles: string[],
  maxResults: number = 5
): Promise<SearchResult[]> {
  const queryEmb = await getEmbedding(query, config);
  const cachePath = join(wikiPath, '.embeddings.json');

  let pageEmbs: Record<string, number[]>;

  // Check in-memory cache (fastest)
  if (embeddingCache && embeddingCache.wikiPath === wikiPath && embeddingCache.model === config.model) {
    pageEmbs = embeddingCache.data;
  }
  // Check file cache with model validation
  else if (existsSync(cachePath)) {
    try {
      const raw = await readFile(cachePath, 'utf-8');
      const parsed = JSON.parse(raw) as CacheData;
      if (parsed._model === config.model) {
        // Cache is valid for this model
        const { _model, _generated, ...embeddings } = parsed;
        pageEmbs = embeddings as Record<string, number[]>;
      } else {
        // Model changed, regenerate
        pageEmbs = await computePageEmbeddings(wikiPath, config, pageFiles);
        await saveCache(cachePath, pageEmbs, config.model);
      }
    } catch {
      pageEmbs = await computePageEmbeddings(wikiPath, config, pageFiles);
      await saveCache(cachePath, pageEmbs, config.model);
    }
  }
  // No cache at all
  else {
    pageEmbs = await computePageEmbeddings(wikiPath, config, pageFiles);
    await saveCache(cachePath, pageEmbs, config.model);
  }

  // Update in-memory cache
  embeddingCache = { data: pageEmbs, model: config.model, wikiPath };

  const results: SearchResult[] = [];
  for (const [slug, emb] of Object.entries(pageEmbs)) {
    results.push({ slug, score: cosineSimilarity(queryEmb, emb) });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, maxResults);
}

async function saveCache(cachePath: string, embeddings: Record<string, number[]>, model: string): Promise<void> {
  try {
    const data: CacheData = {
      _model: model,
      _generated: new Date().toISOString(),
      ...embeddings,
    };
    await writeFile(cachePath, JSON.stringify(data), 'utf-8');
  } catch { /* non-critical */ }
}

export function clearEmbeddingCache(): void {
  embeddingCache = null;
}
