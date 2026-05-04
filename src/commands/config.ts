import inquirer from 'inquirer';
import { loadConfig, saveConfig, loadDefaultModels, getProviders, getModelsByProvider, getConfigPath, supportsJsonMode, getEmbeddingProviders, getEmbeddingModelsByProvider } from '../config/config-store.js';
import type { WikiCliConfig } from '../config/config-store.js';
import { logSuccess, logInfo } from '../utils/progress.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
          { name: 'Repos Directory (where to store cloned repos)', value: 'repos' },
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

  if (mode === 'repos') {
    await configureRepoDirs(fullConfig);
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

async function configureRepoDirs(config: WikiCliConfig): Promise<void> {
  const defaultDir = join(homedir(), '.wiki-cli', 'repos');
  const current = config.repoDirs?.length ? config.repoDirs : [defaultDir];

  while (true) {
    const lines = current.map((d, i) => `  ${i === 0 ? '📁' : '  '} ${d}`).join('\n');
    console.log(`\n当前仓库目录${current.length > 1 ? `（${current.length} 个，首项为默认）` : '：'}\n${lines}\n`);

    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: '操作：',
        choices: [
          { name: '➕ 新增目录', value: 'add' },
          ...(current.length > 1 ? [{ name: '🗑️ 移除目录', value: 'remove' }] : []),
          { name: '✅ 完成', value: 'done' },
        ],
      },
    ]);

    if (action === 'done') break;

    if (action === 'add') {
      const { newDir } = await inquirer.prompt([
        {
          type: 'input',
          name: 'newDir',
          message: '新仓库目录路径（绝对路径）：',
          validate: (v: string) => v.trim() ? true : '路径不能为空',
        },
      ]);
      if (newDir.trim()) {
        const clean = newDir.trim().replace(/\\/g, '/');
        if (!current.includes(clean)) current.push(clean);
      }
    }

    if (action === 'remove') {
      const { idx } = await inquirer.prompt([
        {
          type: 'list',
          name: 'idx',
          message: '选择要移除的目录：',
          choices: current.map((d, i) => ({ name: d, value: i })),
        },
      ]);
      if (idx === 0) {
        logInfo('不能移除默认目录（首项）。请先新增其他目录。');
      } else {
        current.splice(idx, 1);
      }
    }
  }

  if (current.length === 1 && current[0] === defaultDir) {
    config.repoDirs = undefined;
  } else {
    config.repoDirs = current;
  }
}
