#!/usr/bin/env node
import { Command } from 'commander';
import { configCommand } from './commands/config.js';
import { generateCommand } from './commands/generate.js';
import { browseCommand } from './commands/browse.js';
import { aiCommand } from './commands/ai.js';
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
  .description('Analyze repository and generate Wiki documentation')
  .option('-C, --dir <path>', 'Local repository directory (default: current directory)')
  .option('-u, --url <url>', 'Git repository URL to clone and generate')
  .option('-o, --output <path>', 'Clone destination path (with --url)')
  .option('-b, --branch <name>', 'Git branch (with --url)')
  .option('-d, --depth <n>', 'Git clone depth (with --url)')
  .option('-t, --temp', 'Temporary mode: clean up clone after done (with --url)')
  .option('-p, --parallel', 'Generate pages in parallel')
  .option('-c, --concurrency <n>', 'Number of concurrent page generations', '3')
  .option('-r, --retry <n>', 'Retry failed pages up to N times', '0')
  .option('-s, --silent', 'Silent mode: no interactive prompts, summary only')
  .action(async (options) => {
    try {
      await generateCommand({
        dir: options.dir,
        url: options.url,
        output: options.output,
        branch: options.branch,
        depth: options.depth ? parseInt(options.depth) : undefined,
        temp: options.temp,
        parallel: options.parallel,
        concurrency: options.concurrency ? parseInt(options.concurrency) : 3,
        retry: options.retry ? parseInt(options.retry) : 0,
        silent: options.silent,
      });
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

program
  .command('ai')
  .description('Interactive AI chat about the codebase')
  .argument('[question]', 'Optional question for single-answer mode')
  .option('-q, --question <text>', 'Question for single-answer mode')
  .option('-C, --dir <path>', 'Local repository directory (default: current directory)')
  .option('-u, --url <url>', 'Git repository URL to clone')
  .option('-o, --output <path>', 'Clone destination path (with --url)')
  .option('-b, --branch <name>', 'Git branch (with --url)')
  .option('-d, --depth <n>', 'Git clone depth (with --url)')
  .option('-t, --temp', 'Temporary mode: clean up clone after done (with --url)')
  .option('--session <id>', 'Resume a specific session')
  .option('--list-sessions', 'List all saved sessions')
  .option('--delete-session <id>', 'Delete a session')
  .option('-a, --answer-only', 'Output only the final answer (no streaming, no thinking)')
  .action(async (question, options) => {
    try {
      const q = options.question || question;
      await aiCommand({
        question: q,
        dir: options.dir,
        url: options.url,
        output: options.output,
        branch: options.branch,
        depth: options.depth ? parseInt(options.depth) : undefined,
        temp: options.temp,
        session: options.session,
        listSessions: options.listSessions,
        deleteSession: options.deleteSession,
        answerOnly: options.answerOnly,
      });
    } catch (err: any) {
      logError(err.message);
      process.exit(1);
    }
  });

program.parse(process.argv);

if (!process.argv.slice(2).length) {
  program.outputHelp();
}
