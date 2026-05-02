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
}

export interface ModelEntry {
  provider: string;
  model: string;
  baseUrl: string;
  description: string;
  pricingHint?: string;
}

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
  if (provider === 'Custom') return undefined; // unknown, ask user
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
