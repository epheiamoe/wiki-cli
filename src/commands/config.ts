import inquirer from 'inquirer';
import { loadConfig, saveConfig, loadDefaultModels, getProviders, getModelsByProvider, getConfigPath, supportsJsonMode, getEmbeddingProviders, getEmbeddingModelsByProvider } from '../config/config-store.js';
import type { WikiCliConfig } from '../config/config-store.js';
import { logSuccess } from '../utils/progress.js';

export async function configCommand(options: Partial<WikiCliConfig>): Promise<void> {
  const models = loadDefaultModels();
  const providers = getProviders(models);
  const existingConfig = await loadConfig();

  if (options.apiKey && options.baseUrl && options.model && options.provider) {
    const config: WikiCliConfig = {
      provider: options.provider,
      baseUrl: options.baseUrl,
      model: options.model,
      apiKey: options.apiKey,
      lang: options.lang || 'zh',
      jsonMode: options.jsonMode,
    };
    await saveConfig(config);
    logSuccess('Configuration saved.');
    return;
  }

  const { providerChoice } = await inquirer.prompt([
    {
      type: 'list',
      name: 'providerChoice',
      message: 'Select LLM provider:',
      choices: [
        ...providers.map(p => ({ name: p, value: p })),
        { name: '✏️  Custom (enter manually)', value: '__custom__' },
      ],
      default: existingConfig?.provider,
    },
  ]);

  let baseUrl: string;
  let model: string;
  let provider: string;

  if (providerChoice === '__custom__') {
    provider = 'Custom';
    const customAnswers = await inquirer.prompt([
      { type: 'input', name: 'baseUrl', message: 'Enter Base URL:', default: existingConfig?.baseUrl },
      { type: 'input', name: 'model', message: 'Enter model name:', default: existingConfig?.model },
    ]);
    baseUrl = customAnswers.baseUrl;
    model = customAnswers.model;
  } else {
    provider = providerChoice;
    const providerModels = getModelsByProvider(models, providerChoice);
    const { selectedModel } = await inquirer.prompt([
      {
        type: 'list',
        name: 'selectedModel',
        message: `Select model for ${providerChoice}:`,
        choices: providerModels.map(m => ({
          name: `${m.model} - ${m.description}${m.pricingHint ? ` (${m.pricingHint})` : ''}`,
          value: m,
        })),
      },
    ]);
    baseUrl = selectedModel.baseUrl;
    model = selectedModel.model;
  }

  const { apiKey } = await inquirer.prompt([
    {
      type: 'password',
      name: 'apiKey',
      message: 'Enter API Key:',
      mask: '*',
      default: existingConfig?.apiKey,
    },
  ]);

  let jsonMode: boolean | undefined;
  const known = supportsJsonMode(provider);
  if (known === undefined) {
    const { jm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'jm',
        message: 'Does this provider support JSON output mode (response_format: json_object)?',
        default: true,
      },
    ]);
    jsonMode = jm;
  } else {
    jsonMode = known;
  }

  const { lang } = await inquirer.prompt([
    {
      type: 'input',
      name: 'lang',
      message: 'Documentation language (zh/en, default zh):',
      default: existingConfig?.lang || 'zh',
    },
  ]);

  // Embedding configuration
  const { useEmbedding } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'useEmbedding',
      message: 'Configure Embedding for semantic wiki search? (optional)',
      default: !!existingConfig?.embeddingModel,
    },
  ]);

  let embeddingProvider: string | undefined;
  let embeddingModel: string | undefined;
  let embeddingBaseUrl: string | undefined;
  let embeddingApiKey: string | undefined;

  if (useEmbedding) {
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
        default: existingConfig?.embeddingProvider,
      },
    ]);

    if (ep === '__custom__') {
      const custom = await inquirer.prompt([
        { type: 'input', name: 'baseUrl', message: 'Embedding API Base URL:', default: existingConfig?.embeddingBaseUrl },
        { type: 'input', name: 'model', message: 'Embedding model name:', default: existingConfig?.embeddingModel },
      ]);
      embeddingBaseUrl = custom.baseUrl;
      embeddingModel = custom.model;
    } else {
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
      embeddingBaseUrl = em.baseUrl;
      embeddingModel = em.model;
    }

    embeddingProvider = ep === '__custom__' ? 'Custom' : ep;

    const { eak } = await inquirer.prompt([
      {
        type: 'password',
        name: 'eak',
        message: 'Embedding API Key (leave empty to reuse LLM API key):',
        mask: '*',
      },
    ]);
    embeddingApiKey = eak || apiKey;
  }

  const config: WikiCliConfig = {
    provider,
    baseUrl,
    model,
    apiKey,
    lang: lang || 'zh',
    jsonMode,
    embeddingProvider,
    embeddingModel,
    embeddingBaseUrl,
    embeddingApiKey,
  };

  await saveConfig(config);
  logSuccess(`Configuration saved to ${getConfigPath()}`);
}
