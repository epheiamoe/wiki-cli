import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ensureDir, writeTextFile, readTextFile, removeDir, fileExists, toSlug, getTimestamp } from '../src/utils/file.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

const testDir = mkdtempSync(join(tmpdir(), 'wiki-cli-test-'));

describe('file utils', () => {
  it('ensureDir should create directory', async () => {
    const dir = join(testDir, 'a', 'b', 'c');
    await ensureDir(dir);
    expect(await fileExists(dir)).toBe(true);
  });

  it('writeTextFile and readTextFile should work', async () => {
    const file = join(testDir, 'hello.txt');
    await writeTextFile(file, 'Hello World');
    const content = await readTextFile(file);
    expect(content).toBe('Hello World');
  });

  it('removeDir should remove directory', async () => {
    const dir = join(testDir, 'toremove');
    await ensureDir(dir);
    await writeTextFile(join(dir, 'nested', 'file.txt'), 'content');
    await removeDir(dir);
    expect(await fileExists(dir)).toBe(false);
  });
});

describe('toSlug', () => {
  it('should convert Chinese title to slug', () => {
    expect(toSlug('概览')).toBe('概览');
  });

  it('should convert English title to slug', () => {
    expect(toSlug('Quick Start Guide')).toBe('quick-start-guide');
  });

  it('should handle mixed content', () => {
    expect(toSlug('Hello 世界')).toBe('hello-世界');
  });

  it('should collapse multiple separators', () => {
    expect(toSlug('a   b---c')).toBe('a-b-c');
  });

  it('should return untitled for empty input', () => {
    expect(toSlug('')).toBe('untitled');
  });

  it('should strip leading and trailing separators', () => {
    expect(toSlug('  hello world  ')).toBe('hello-world');
  });

  it('should handle special characters', () => {
    expect(toSlug('test@#$file!')).toBe('test-file');
  });
});

describe('getTimestamp', () => {
  it('should return timestamp in correct format', () => {
    const ts = getTimestamp();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
  });

  it('should return current year', () => {
    const ts = getTimestamp();
    expect(ts.startsWith(String(new Date().getFullYear()))).toBe(true);
  });
});
