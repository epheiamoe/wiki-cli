import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface EmbeddingConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
}

let embeddingCache: Record<string, number[]> | null = null;
let cacheWikiPath: string | null = null;

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

  // Use cache or compute
  const cachePath = join(wikiPath, '.embeddings.json');
  let pageEmbs: Record<string, number[]>;

  if (embeddingCache && cacheWikiPath === wikiPath) {
    pageEmbs = embeddingCache;
  } else if (existsSync(cachePath)) {
    try {
      pageEmbs = JSON.parse(await readFile(cachePath, 'utf-8'));
    } catch {
      pageEmbs = await computePageEmbeddings(wikiPath, config, pageFiles);
    }
  } else {
    pageEmbs = await computePageEmbeddings(wikiPath, config, pageFiles);
    try {
      await writeFile(cachePath, JSON.stringify(pageEmbs), 'utf-8');
    } catch { /* non-critical */ }
  }

  embeddingCache = pageEmbs;
  cacheWikiPath = wikiPath;

  const results: SearchResult[] = [];
  for (const [slug, emb] of Object.entries(pageEmbs)) {
    results.push({ slug, score: cosineSimilarity(queryEmb, emb) });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, maxResults);
}

export function clearEmbeddingCache(): void {
  embeddingCache = null;
  cacheWikiPath = null;
}
