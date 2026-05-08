import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface ChangedFile {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed';
}

export interface PageDeps {
  [slug: string]: {
    [filePath: string]: [number, number][];
  };
}

export interface Ranges {
  [filePath: string]: [number, number][];
}

export const DEFAULT_EXCLUDE = [
  'README*', 'readme*',
  'AGENTS.md', 'agents.md',
  'CONTRIBUTING*',
  'CHANGELOG*', 'CHANGES*',
  'LICENSE*',
  '.gitignore', '.gitattributes', '.editorconfig',
  '.prettierrc*', '.eslintrc*',
];

export function loadExcludePatterns(): string[] {
  try {
    const cfgPath = join(homedir(), '.wiki-cli', 'config.json');
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
      if (cfg.excludePatterns?.length) return cfg.excludePatterns;
    }
  } catch { /* ignore */ }
  return DEFAULT_EXCLUDE;
}

/** Check if a file path matches any exclude pattern (basename matching). */
function matchesAny(path: string, patterns: string[]): boolean {
  const normalized = path.replace(/\\/g, '/');
  const basename = normalized.split('/').pop() || normalized;
  for (const p of patterns) {
    if (!p.includes('*')) {
      if (basename === p || normalized === p) return true;
      continue;
    }
    // wildcard: split on *, check prefix + suffix of basename
    const parts = p.split('*');
    const prefix = parts[0];
    const suffix = parts[parts.length - 1];
    if (basename.startsWith(prefix) && basename.endsWith(suffix)) return true;
  }
  return false;
}

export function isExcludedFile(filePath: string): boolean {
  return matchesAny(filePath, loadExcludePatterns());
}

function parseGitDiff(raw: string): ChangedFile[] {
  return raw
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const status = line.startsWith('A\t') ? 'added' as const
        : line.startsWith('D\t') ? 'deleted' as const
        : line.startsWith('R') ? 'renamed' as const
        : 'modified' as const;
      const path = line.replace(/^[A-Z]+\t/, '');
      return { path, status };
    });
}

export function getChangedFiles(oldCommit: string, cwd: string): ChangedFile[] {
  const raw = execSync(
    `git diff ${oldCommit}..HEAD --name-status --diff-filter=ADMR`,
    { encoding: 'utf-8', cwd }
  ).trim();
  if (!raw) return [];
  return parseGitDiff(raw).filter(f =>
    !f.path.startsWith('.wiki/') && f.path !== '.wiki' && !isExcludedFile(f.path)
  );
}

export function getChangedRanges(oldCommit: string, filePath: string, cwd: string): [number, number][] {
  try {
    const raw = execSync(
      `git diff ${oldCommit}..HEAD -- "${filePath}"`,
      { encoding: 'utf-8', cwd }
    );
    return parseHunks(raw);
  } catch {
    return [];
  }
}

function parseHunks(diff: string): [number, number][] {
  const ranges: [number, number][] = [];
  const hunkHeaderRe = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
  for (const line of diff.split('\n')) {
    const m = line.match(hunkHeaderRe);
    if (m) {
      const start = parseInt(m[1]);
      const count = parseInt(m[2] || '1');
      ranges.push([start, start + count - 1]);
    }
  }
  return ranges;
}

export function rangesOverlap(
  pageRanges: [number, number][],
  changedRanges: [number, number][]
): boolean {
  for (const [ps, pe] of pageRanges) {
    for (const [cs, ce] of changedRanges) {
      if (ps <= ce && pe >= cs) return true;
    }
  }
  return false;
}

export function getAffectedSlugs(
  pageDeps: PageDeps,
  changedFiles: ChangedFile[],
  cwd: string,
  oldCommit: string
): Set<string> {
  const affected = new Set<string>();

  for (const cf of changedFiles) {
    if (cf.status === 'deleted' || cf.status === 'renamed') {
      // Conservative: mark all pages that touched this file
      for (const [slug, deps] of Object.entries(pageDeps)) {
        if (deps[cf.path]) affected.add(slug);
      }
      continue;
    }

    const changedRanges = getChangedRanges(oldCommit, cf.path, cwd);
    if (changedRanges.length === 0) continue;

    for (const [slug, deps] of Object.entries(pageDeps)) {
      const fileRanges = deps[cf.path];
      if (!fileRanges) continue;
      if (rangesOverlap(fileRanges, changedRanges)) {
        affected.add(slug);
      }
    }
  }

  return affected;
}
