#!/usr/bin/env node
import { Command } from 'commander';
import { configCommand } from './commands/config.js';
import { generateCommand } from './commands/generate.js';
import { browseCommand } from './commands/browse.js';
import { loadConfig } from './config/config-store.js';
import { logError } from './utils/progress.js';

const program = new Command();

program
  .name('wiki-cli')
  .description('Auto-generate structured Wiki documentation for any local code repository')
  .version('1.0.0');

program
  .command('config')
  .description('Interactive configuration of LLM provider, model, API key, language')
  .option('--provider <provider>', 'LLM provider name')
  .option('--base-url <url>', 'API base URL')
  .option('--model <model>', 'Model name')
  .option('--api-key <key>', 'API key')
  .option('--lang <lang>', 'Documentation language (zh/en)')
  .action(async (options) => {
    try {
      await configCommand(options);
    } catch (err: any) {
      logError(err.message);
      process.exit(1);
    }
  });

program
  .command('generate')
  .description('Analyze current repository and generate Wiki documentation')
  .action(async () => {
    try {
      await generateCommand();
      process.exit(0);
    } catch (err: any) {
      logError(err.message);
      process.exit(1);
    }
  });

program
  .command('browse')
  .description('Open generated Wiki in browser')
  .action(async () => {
    try {
      await browseCommand();
    } catch (err: any) {
      logError(err.message);
      process.exit(1);
    }
  });

program.parse(process.argv);

if (!process.argv.slice(2).length) {
  program.outputHelp();
}
