import ora from 'ora';
import chalk from 'chalk';

export function createSpinner(text: string) {
  return ora(text).start();
}

export function logInfo(msg: string): void {
  console.log(chalk.blue('ℹ'), msg);
}

export function logSuccess(msg: string): void {
  console.log(chalk.green('✔'), msg);
}

export function logWarning(msg: string): void {
  console.log(chalk.yellow('⚠'), msg);
}

export function logError(msg: string): void {
  console.log(chalk.red('✖'), msg);
}

export function logStreamContent(content: string): void {
  process.stdout.write(chalk.cyan(content));
}

export function logToolCall(name: string, args: any): void {
  console.log(chalk.magenta('🔧'), chalk.bold(`Tool: ${name}`), chalk.gray(JSON.stringify(args)));
}

export function logToolResult(name: string, result: any): void {
  const preview = typeof result.data === 'string'
    ? result.data.slice(0, 100) + (result.data.length > 100 ? '...' : '')
    : JSON.stringify(result.data).slice(0, 100);
  console.log(chalk.green('  ↳'), chalk.gray(`Result: ${preview}`));
}
