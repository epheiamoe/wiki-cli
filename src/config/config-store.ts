import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import defaultModels from './default-models.json' with { type: 'json' };

export interface WikiCliConfig {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  lang: string;
  jsonMode?: boolean;
  embeddingProvider?: string;
  embeddingModel?: string;
  embeddingBaseUrl?: string;
  embeddingApiKey?: string;
  webFetchDisabled?: boolean;
  webFetchProvider?: string;
  webFetchBaseUrl?: string;
  webFetchApiKey?: string;
}

export interface ModelEntry {
  provider: string;
  model: string;
  baseUrl: string;
  description: string;
  pricingHint?: string;
}

export interface EmbeddingModelEntry {
  provider: string;
  model: string;
  baseUrl: string;
  description: string;
  dimensions: number;
  pricingHint?: string;
}

export const EMBEDDING_MODELS: EmbeddingModelEntry[] = [
  { provider: 'OpenAI', model: 'text-embedding-3-large', baseUrl: 'https://api.openai.com/v1', description: '最佳通用，MTEB ~64.6', dimensions: 3072, pricingHint: '~$0.13/MT' },
  { provider: 'OpenAI', model: 'text-embedding-3-small', baseUrl: 'https://api.openai.com/v1', description: '日常 RAG 首选，性价比高', dimensions: 1536, pricingHint: '~$0.02/MT' },
  { provider: 'OpenAI', model: 'text-embedding-ada-002', baseUrl: 'https://api.openai.com/v1', description: '遗留模型，建议迁移', dimensions: 1536, pricingHint: '~$0.10/MT' },
  { provider: 'Google Gemini', model: 'gemini-embedding-2', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', description: 'MTEB 领先，跨模态', dimensions: 3072, pricingHint: '~$0.006-0.15/MT' },
  { provider: 'Cohere', model: 'embed-v4', baseUrl: 'https://api.cohere.com', description: '100+ 语言多语言旗舰', dimensions: 4096, pricingHint: '~$0.10/MT' },
  { provider: 'Voyage AI', model: 'voyage-4-large', baseUrl: 'https://api.voyageai.com/v1', description: '代码/技术文档最佳', dimensions: 2048, pricingHint: '~$0.12/MT' },
  { provider: 'Voyage AI', model: 'voyage-4-lite', baseUrl: 'https://api.voyageai.com/v1', description: '高吞吐轻量版', dimensions: 2048, pricingHint: '~$0.02/MT' },
  { provider: 'Jina AI', model: 'jina-embeddings-v3', baseUrl: 'https://api.jina.ai/v1', description: '长上下文/多语言', dimensions: 1024, pricingHint: '~$0.02/MT' },
  { provider: 'Mistral', model: 'mistral-embed', baseUrl: 'https://api.mistral.ai/v1', description: 'Mistral 官方嵌入', dimensions: 1024, pricingHint: '~$0.10/MT' },
];

const CONFIG_DIR = join(homedir(), '.wiki-cli');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

const JSON_MODE_PROVIDERS = new Set([
  'OpenAI',
  'DeepSeek',
  'xAI Grok',
  'Mistral',
  'Kimi (Moonshot)',
]);

export function supportsJsonMode(provider: string): boolean | undefined {
  if (provider === 'Custom') return undefined;
  return JSON_MODE_PROVIDERS.has(provider);
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export async function loadConfig(): Promise<WikiCliConfig | null> {
  try {
    if (!existsSync(CONFIG_PATH)) return null;
    const raw = await readFile(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as WikiCliConfig;
  } catch {
    return null;
  }
}

export async function saveConfig(config: WikiCliConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

export function loadDefaultModels(): ModelEntry[] {
  return defaultModels as ModelEntry[];
}

export function getProviders(models: ModelEntry[]): string[] {
  const providers = new Set(models.map(m => m.provider));
  return [...providers];
}

export function getModelsByProvider(models: ModelEntry[], provider: string): ModelEntry[] {
  return models.filter(m => m.provider === provider);
}

export function getEmbeddingProviders(): string[] {
  const providers = new Set(EMBEDDING_MODELS.map(m => m.provider));
  return [...providers];
}

export function getEmbeddingModelsByProvider(provider: string): EmbeddingModelEntry[] {
  return EMBEDDING_MODELS.filter(m => m.provider === provider);
}
