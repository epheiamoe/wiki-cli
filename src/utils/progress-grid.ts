import chalk from 'chalk';

interface Row {
  status: 'waiting' | 'thinking' | 'tool' | 'done' | 'failed';
  title: string;
  detail: string;
  toolCount: number;
}

export class ProgressGrid {
  private rows: Row[];
  private rendered = false;

  constructor(titles: string[]) {
    this.rows = titles.map(t => ({ status: 'waiting' as const, title: t, detail: '', toolCount: 0 }));
  }

  render(): void {
    this.rendered = true;
    for (let i = 0; i < this.rows.length; i++) {
      console.log(this.formatRow(i));
    }
  }

  update(index: number, status: Row['status'], detail: string): void {
    if (index < 0 || index >= this.rows.length) return;
    this.rows[index] = { ...this.rows[index], status, detail };
    if (status === 'tool' || status === 'thinking') {
      this.rows[index].toolCount++;
    }
    this.redraw();
  }

  finish(): void {
    if (!this.rendered) return;
    this.rendered = false;
    const n = this.rows.length;
    process.stdout.write(`\x1b[${n}A`);
    for (let i = 0; i < n; i++) {
      process.stdout.write('\r\x1b[2K');
      if (i < n - 1) process.stdout.write('\n');
    }
    process.stdout.write(`\x1b[${n - 1}A`);
  }

  private redraw(): void {
    if (!this.rendered) return;
    const n = this.rows.length;
    process.stdout.write(`\x1b[${n}A`);
    for (let i = 0; i < n; i++) {
      process.stdout.write('\r\x1b[2K');
      console.log(this.formatRow(i));
    }
  }

  private formatRow(index: number): string {
    const row = this.rows[index];
    const total = this.rows.length;
    const idx = `[${index + 1}/${total}]`;
    const maxW = (process.stdout.columns || 80);

    let icon: string;
    switch (row.status) {
      case 'waiting': icon = '⏳'; break;
      case 'thinking': icon = '🔄'; break;
      case 'tool': icon = '🔄'; break;
      case 'done': icon = '✔'; break;
      case 'failed': icon = '✖'; break;
    }

    // Truncate detail to fit terminal width
    const prefix = ` ${icon} ${idx} ${this.colorize(row.status, row.title)}`;
    let suffix = '';
    if (row.status === 'waiting') suffix = chalk.dim(' 等待中');
    else if (row.status === 'thinking') suffix = chalk.dim.yellow(` 思考: ${row.detail.slice(0, 40)}`);
    else if (row.status === 'tool') suffix = chalk.dim.cyan(` 工具: ${row.detail.slice(0, 20)} (${row.toolCount})`);
    else if (row.status === 'done') suffix = row.toolCount > 0 ? chalk.dim(` (${row.toolCount} 次工具调用)`) : chalk.dim(' ✓');
    else if (row.status === 'failed') suffix = chalk.dim(' 失败');

    const line = `${prefix}${suffix}`;
    return line.length > maxW ? line.slice(0, maxW - 1) + '…' : line;
  }

  private colorize(status: Row['status'], text: string): string {
    switch (status) {
      case 'waiting': return chalk.dim(text);
      case 'thinking': return chalk.yellow(text);
      case 'tool': return chalk.cyan(text);
      case 'done': return chalk.green(text);
      case 'failed': return chalk.red(text);
    }
  }
}
