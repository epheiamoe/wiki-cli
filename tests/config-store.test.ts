import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getProviders, getModelsByProvider } from '../src/config/config-store.js';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const modelsPath = join(__dirname, '..', 'src', 'config', 'default-models.json');

describe('default-models.json', () => {
  let models: any[];

  beforeAll(async () => {
    const raw = await readFile(modelsPath, 'utf-8');
    models = JSON.parse(raw);
  });

  it('should be a valid JSON array', () => {
    expect(Array.isArray(models)).toBe(true);
  });

  it('should have at least 20 model entries', () => {
    expect(models.length).toBeGreaterThanOrEqual(20);
  });

  it('every entry should have provider, model, baseUrl, description', () => {
    for (const m of models) {
      expect(m).toHaveProperty('provider');
      expect(m).toHaveProperty('model');
      expect(m).toHaveProperty('baseUrl');
      expect(m).toHaveProperty('description');
    }
  });

  it('should include all required providers', () => {
    const providers = getProviders(models);
    expect(providers).toContain('OpenAI');
    expect(providers).toContain('Google Gemini');
    expect(providers).toContain('Anthropic');
    expect(providers).toContain('xAI Grok');
    expect(providers).toContain('DeepSeek');
    expect(providers).toContain('Kimi (Moonshot)');
    expect(providers).toContain('Mistral');
  });

  it('should contain specific key models', () => {
    const modelNames = models.map(m => m.model);
    expect(modelNames).toContain('gpt-5.5');
    expect(modelNames).toContain('gemini-3.1-pro');
    expect(modelNames).toContain('claude-opus-4-7');
    expect(modelNames).toContain('deepseek-v4-flash');
    expect(modelNames).toContain('grok-4.3');
    expect(modelNames).toContain('mistral-large-3');
  });

  it('getModelsByProvider should filter correctly', () => {
    const openaiModels = getModelsByProvider(models, 'OpenAI');
    expect(openaiModels.every(m => m.provider === 'OpenAI')).toBe(true);
  });

  it('getProviders should return unique providers', () => {
    const providers = getProviders(models);
    expect(new Set(providers).size).toBe(providers.length);
  });
});
