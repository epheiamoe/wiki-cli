import inquirer from 'inquirer';
import { loadConfig, saveConfig, loadDefaultModels, getProviders, getModelsByProvider, getConfigPath, supportsJsonMode, getEmbeddingProviders, getEmbeddingModelsByProvider } from '../config/config-store.js';
import type { WikiCliConfig } from '../config/config-store.js';
import { logSuccess } from '../utils/progress.js';

export async function configCommand(options: Partial<WikiCliConfig & { llmOnly?: boolean; embeddingOnly?: boolean }>): Promise<void> {
  const models = loadDefaultModels();
  const providers = getProviders(models);
  const existing = await loadConfig();

  const fullConfig: WikiCliConfig = existing || { provider: '', baseUrl: '', model: '', apiKey: '', lang: 'zh' };

  if (options.apiKey && options.baseUrl && options.model && options.provider) {
    fullConfig.provider = options.provider;
    fullConfig.baseUrl = options.baseUrl;
    fullConfig.model = options.model;
    fullConfig.apiKey = options.apiKey;
    if (options.lang) fullConfig.lang = options.lang;
    if (options.jsonMode !== undefined) fullConfig.jsonMode = options.jsonMode;
    await saveConfig(fullConfig);
    logSuccess(`Configuration saved to ${getConfigPath()}`);
    return;
  }

  const llmOnly = options.llmOnly;
  const embeddingOnly = options.embeddingOnly;

  let mode = 'both';
  if (llmOnly) mode = 'llm';
  else if (embeddingOnly) mode = 'embedding';
  else {
    const { m } = await inquirer.prompt([
      {
        type: 'list',
        name: 'm',
        message: 'What do you want to configure?',
        choices: [
          { name: 'LLM (provider / model / API key)', value: 'llm' },
          { name: 'Embedding (semantic search model)', value: 'embedding' },
          { name: 'Web Fetch (let AI read documentation URLs)', value: 'webFetch' },
          { name: 'Both', value: 'both' },
          { name: 'Done, quit', value: 'quit' },
        ],
      },
    ]);
    if (m === 'quit') return;
    mode = m;
  }

  if (mode === 'llm' || mode === 'both') {
    await configureLlm(fullConfig, models, providers);
  }

  if (mode === 'embedding' || mode === 'both') {
    await configureEmbedding(fullConfig);
  }

  if (mode === 'webFetch') {
    await configureWebFetch(fullConfig);
  }

  if (mode === 'both' && !existing) {
    const { lang } = await inquirer.prompt([
      {
        type: 'input',
        name: 'lang',
        message: 'Documentation language (zh/en, default zh):',
        default: fullConfig.lang || 'zh',
      },
    ]);
    fullConfig.lang = lang || 'zh';
  }

  await saveConfig(fullConfig);
  logSuccess(`Configuration saved to ${getConfigPath()}`);
}

async function configureLlm(config: WikiCliConfig, models: any[], providers: string[]): Promise<void> {
  const { providerChoice } = await inquirer.prompt([
    {
      type: 'list',
      name: 'providerChoice',
      message: 'Select LLM provider:',
      choices: [
        ...providers.map(p => ({ name: p, value: p })),
        { name: '✏️  Custom (enter manually)', value: '__custom__' },
      ],
      default: config.provider || undefined,
    },
  ]);

  if (providerChoice === '__custom__') {
    config.provider = 'Custom';
    const answers = await inquirer.prompt([
      { type: 'input', name: 'baseUrl', message: 'Enter Base URL:', default: config.baseUrl },
      { type: 'input', name: 'model', message: 'Enter model name:', default: config.model },
    ]);
    config.baseUrl = answers.baseUrl;
    config.model = answers.model;
  } else {
    config.provider = providerChoice;
    const pm = getModelsByProvider(models, providerChoice);
    const { selected } = await inquirer.prompt([
      {
        type: 'list',
        name: 'selected',
        message: `Select model for ${providerChoice}:`,
        choices: pm.map(m => ({
          name: `${m.model} - ${m.description}${m.pricingHint ? ` (${m.pricingHint})` : ''}`,
          value: m,
        })),
      },
    ]);
    config.baseUrl = selected.baseUrl;
    config.model = selected.model;
  }

  const { key } = await inquirer.prompt([
    { type: 'password', name: 'key', message: 'Enter API Key:', mask: '*', default: config.apiKey },
  ]);
  config.apiKey = key;

  const known = supportsJsonMode(config.provider);
  if (known === undefined) {
    const { jm } = await inquirer.prompt([
      { type: 'confirm', name: 'jm', message: 'Does this provider support JSON output mode?', default: true },
    ]);
    config.jsonMode = jm;
  } else {
    config.jsonMode = known;
  }
}

async function configureEmbedding(config: WikiCliConfig): Promise<void> {
  const { useEmbedding } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'useEmbedding',
      message: 'Configure Embedding for semantic wiki search? (optional)',
      default: !!config.embeddingModel,
    },
  ]);

  if (!useEmbedding) {
    config.embeddingProvider = undefined;
    config.embeddingModel = undefined;
    config.embeddingBaseUrl = undefined;
    config.embeddingApiKey = undefined;
    return;
  }

  const embeddingProviders = getEmbeddingProviders();
  const { ep } = await inquirer.prompt([
    {
      type: 'list',
      name: 'ep',
      message: 'Select Embedding provider:',
      choices: [
        ...embeddingProviders.map(p => ({ name: p, value: p })),
        { name: '✏️  Custom (enter manually)', value: '__custom__' },
      ],
      default: config.embeddingProvider,
    },
  ]);

  if (ep === '__custom__') {
    config.embeddingProvider = 'Custom';
    const answers = await inquirer.prompt([
      { type: 'input', name: 'baseUrl', message: 'Embedding API Base URL:', default: config.embeddingBaseUrl },
      { type: 'input', name: 'model', message: 'Embedding model name:', default: config.embeddingModel },
    ]);
    config.embeddingBaseUrl = answers.baseUrl;
    config.embeddingModel = answers.model;
  } else {
    config.embeddingProvider = ep;
    const epModels = getEmbeddingModelsByProvider(ep);
    const { em } = await inquirer.prompt([
      {
        type: 'list',
        name: 'em',
        message: `Select embedding model for ${ep}:`,
        choices: epModels.map(m => ({
          name: `${m.model} - ${m.description}${m.pricingHint ? ` (${m.pricingHint})` : ''}`,
          value: m,
        })),
      },
    ]);
    config.embeddingBaseUrl = em.baseUrl;
    config.embeddingModel = em.model;
  }

  const { eak } = await inquirer.prompt([
    {
      type: 'password',
      name: 'eak',
      message: 'Embedding API Key (leave empty to reuse LLM API key):',
      mask: '*',
      default: config.embeddingApiKey || config.apiKey,
    },
  ]);
  config.embeddingApiKey = eak || config.apiKey;
}

async function configureWebFetch(config: WikiCliConfig): Promise<void> {
  const { enable } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'enable',
      message: 'Enable Web Fetch? (lets AI read documentation URLs via Jina Reader)',
      default: !config.webFetchDisabled,
    },
  ]);

  if (!enable) {
    config.webFetchDisabled = true;
    config.webFetchProvider = undefined;
    config.webFetchBaseUrl = undefined;
    config.webFetchApiKey = undefined;
    return;
  }

  config.webFetchDisabled = false;

  const { provider } = await inquirer.prompt([
    {
      type: 'input',
      name: 'provider',
      message: 'Web Fetch provider (default: jina):',
      default: config.webFetchProvider || 'jina',
    },
  ]);
  config.webFetchProvider = provider || 'jina';

  const { baseUrl } = await inquirer.prompt([
    {
      type: 'input',
      name: 'baseUrl',
      message: 'Base URL (default: https://r.jina.ai):',
      default: config.webFetchBaseUrl || 'https://r.jina.ai',
    },
  ]);
  config.webFetchBaseUrl = baseUrl || 'https://r.jina.ai';

  const { key } = await inquirer.prompt([
    {
      type: 'password',
      name: 'key',
      message: 'API Key (optional, for higher rate limits. Leave empty for free tier):',
      mask: '*',
      default: config.webFetchApiKey || '',
    },
  ]);
  config.webFetchApiKey = key || undefined;
}
