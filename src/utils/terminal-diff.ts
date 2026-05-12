import { diffLines } from 'diff';
import chalk from 'chalk';

const CONTEXT = 2;

export function formatTerminalDiff(oldText: string, newText: string): string {
  const changes = diffLines(oldText, newText);
  const lines: string[] = [];
  let skipContext = 0;

  for (let i = 0; i < changes.length; i++) {
    const part = changes[i];

    if (!part.added && !part.removed) {
      // Unchanged — show context around changes
      const contentLines = part.value.split('\n').filter(l => l !== '');
      if (contentLines.length === 0) continue;

      const hasChangeNearby =
        (i > 0 && (changes[i - 1].added || changes[i - 1].removed)) ||
        (i < changes.length - 1 && (changes[i + 1].added || changes[i + 1].removed));

      if (!hasChangeNearby) continue;

      // Show limited context
      const show = Math.min(contentLines.length, CONTEXT);
      for (let j = 0; j < show; j++) {
        lines.push(chalk.dim(` ${contentLines[j]}`));
      }
      if (contentLines.length > CONTEXT) {
        lines.push(chalk.dim(` ${chalk.gray('...')}`));
      }
      continue;
    }

    // Added or removed
    for (const line of part.value.split('\n')) {
      if (line === '') continue;
      if (part.added) {
        lines.push(chalk.green(`+ ${line}`));
      } else {
        lines.push(chalk.red(`- ${line}`));
      }
    }
  }

  return lines.join('\n');
}

export function showDiffAndPrompt(
  slug: string,
  oldContent: string,
  newContent: string
): void {
  const diff = formatTerminalDiff(oldContent, newContent);
  console.log(`\n${chalk.bold(`=== ${slug} ===`)}`);
  console.log(chalk.cyan('--- 旧版本'));
  console.log(chalk.cyan('+++ 新版本'));
  console.log(diff);
  console.log();
}
