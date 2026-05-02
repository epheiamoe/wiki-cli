import { readFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROMPTS_DIR = resolve(__dirname, '..', '..', 'prompts');

export interface PromptVars {
  [key: string]: string;
}

export async function loadPrompt(filename: string): Promise<string> {
  const fullPath = join(PROMPTS_DIR, filename);
  return readFile(fullPath, 'utf-8');
}

export function fillPrompt(template: string, vars: PromptVars): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  return result;
}

export async function renderPrompt(filename: string, vars: PromptVars): Promise<string> {
  const template = await loadPrompt(filename);
  return fillPrompt(template, vars);
}
