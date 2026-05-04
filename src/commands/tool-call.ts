import { loadConfig } from '../config/config-store.js';
import { initTools, executeToolCall, toolDefinitions } from '../ai/tools.js';
import { logError } from '../utils/progress.js';

export async function toolCallCommand(name: string, argsJson?: string): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    logError('No configuration found. Run "wiki-cli config" first.');
    process.exit(1);
  }

  const validTool = toolDefinitions.find(t => t.function.name === name);
  if (!validTool) {
    const names = toolDefinitions.map(t => `  ${t.function.name}`).join('\n');
    logError(`Unknown tool: "${name}".\nAvailable tools:\n${names}`);
    process.exit(1);
  }

  const webConfig = !config.webFetchDisabled
    ? { baseUrl: config.webFetchBaseUrl || 'https://r.jina.ai', apiKey: config.webFetchApiKey }
    : { disabled: true as const, baseUrl: '', apiKey: '' };

  if (config.embeddingModel && config.embeddingBaseUrl && config.embeddingApiKey) {
    initTools(
      { provider: config.embeddingProvider || '', model: config.embeddingModel, baseUrl: config.embeddingBaseUrl, apiKey: config.embeddingApiKey },
      webConfig,
      process.cwd(),
    );
  } else {
    initTools(undefined, webConfig, process.cwd());
  }

  let args: any = {};
  if (argsJson) {
    try {
      args = JSON.parse(argsJson);
    } catch {
      logError('Invalid JSON arguments');
      process.exit(1);
    }
  }

  const result = await executeToolCall(name, args);
  console.log(JSON.stringify(result));
}
