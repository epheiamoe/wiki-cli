#!/usr/bin/env node
import { Command } from 'commander';
import { configCommand } from './commands/config.js';
import { generateCommand } from './commands/generate.js';
import { browseCommand } from './commands/browse.js';
import { statusCommand } from './commands/status.js';
import { aiCommand } from './commands/ai.js';
import { toolCallCommand } from './commands/tool-call.js';
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
  .option('--llm-only', 'Configure only LLM settings')
  .option('--embedding-only', 'Configure only Embedding settings')
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
  .option('-o, --output <path>', 'Output path for wiki (with --url: clone destination)')
  .option('-b, --branch <name>', 'Git branch to checkout (local or with --url)')
  .option('-d, --depth <n>', 'Git clone depth (with --url)')
  .option('-t, --temp', 'Temporary mode: clean up clone after done (with --url)')
  .option('-p, --parallel', 'Generate pages in parallel')
  .option('-c, --concurrency <n>', 'Number of concurrent page generations', '3')
  .option('-r, --retry <n>', 'Retry failed pages up to N times', '0')
  .option('-s, --silent', 'Silent mode: no interactive prompts, summary only')
  .option('--browse', 'Auto-start browse server after generation')
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
  .option('-p, --path <path>', 'Wiki directory or project path (default: .wiki in current directory)')
  .option('-u, --url <url>', 'Git repository URL (look up cached wiki)')
  .action(async (options) => {
    try {
      await browseCommand({ path: options.path, url: options.url });
    } catch (err: any) {
      logError(err.message);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Show Wiki version status and compare with current git state')
  .option('-v, --version <ts>', 'Wiki version timestamp (default: latest)')
  .option('-C, --dir <path>', 'Project directory (default: current directory)')
  .option('-u, --url <url>', 'Git repository URL (look up cached wiki)')
  .option('--log', 'Show git log since wiki was generated')
  .option('--stat', 'Show git log with file stats since wiki was generated')
  .action(async (options) => {
    try {
      await statusCommand({
        version: options.version,
        dir: options.dir,
        url: options.url,
        log: options.log,
        stat: options.stat,
      });
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
  .option('--all', 'With --list-sessions, show sessions from all projects')
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
        listAllSessions: options.all,
        deleteSession: options.deleteSession,
        answerOnly: options.answerOnly,
      });
    } catch (err: any) {
      logError(err.message);
      process.exit(1);
    }
  });

program
  .command('tool-call')
  .description('Execute a tool and output JSON result (for AI agents)')
  .argument('<name>', 'Tool name')
  .argument('[args]', 'JSON arguments string')
  .action(async (name, args) => {
    try {
      await toolCallCommand(name, args);
    } catch (err: any) {
      logError(err.message);
      process.exit(1);
    }
  });

program.parse(process.argv);

if (!process.argv.slice(2).length) {
  program.outputHelp();
}
