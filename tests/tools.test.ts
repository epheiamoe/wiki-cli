import { describe, it, expect } from 'vitest';
import { toolDefinitions, executeToolCall } from '../src/ai/tools.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';

const testDir = mkdtempSync(join(tmpdir(), 'wiki-cli-tools-test-'));
writeFileSync(join(testDir, 'test.txt'), 'hello world\nline 2\nline 3\n');
writeFileSync(join(testDir, 'app.ts'), 'const x: number = 1;\n');
mkdirSync(join(testDir, 'subdir'));
writeFileSync(join(testDir, 'subdir', 'nested.txt'), 'nested content');

describe('toolDefinitions', () => {
  it('should export toolDefinitions array', () => {
    expect(Array.isArray(toolDefinitions)).toBe(true);
  });

  it('should have all 10 tools', () => {
    expect(toolDefinitions.length).toBe(10);
  });

  it('should include list_directory', () => {
    const names = toolDefinitions.map(t => t.function.name);
    expect(names).toContain('list_directory');
    expect(names).toContain('list_files');
    expect(names).toContain('read_file');
    expect(names).toContain('search_in_files');
    expect(names).toContain('git_log');
    expect(names).toContain('git_show');
    expect(names).toContain('git_remote_info');
    expect(names).toContain('dotenv_template');
    expect(names).toContain('list_wiki_pages');
    expect(names).toContain('read_wiki');
  });

  it('each tool should have valid schema with type "object"', () => {
    for (const t of toolDefinitions) {
      expect(t.function.parameters.type).toBe('object');
    }
  });
});

describe('executeToolCall', () => {
  it('list_files should return files in directory', async () => {
    const result = await executeToolCall('list_files', { path: testDir });
    expect(result.type).toBe('success');
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data.some((f: string) => f.endsWith('test.txt'))).toBe(true);
  });

  it('list_files with extension filter should work', async () => {
    const result = await executeToolCall('list_files', { path: testDir, extensions: ['.ts'] });
    expect(result.type).toBe('success');
    expect(result.data.length).toBe(1);
    expect(result.data[0]).toContain('app.ts');
  });

  it('read_file should return file contents', async () => {
    const result = await executeToolCall('read_file', { file_path: join(testDir, 'test.txt') });
    expect(result.type).toBe('success');
    expect(result.data).toContain('hello world');
  });

  it('read_file with line range should work', async () => {
    const result = await executeToolCall('read_file', { file_path: join(testDir, 'test.txt'), start_line: 1, end_line: 1 });
    expect(result.type).toBe('success');
    expect(result.data).toBe('hello world');
  });

  it('read_file should error on missing file', async () => {
    const result = await executeToolCall('read_file', { file_path: join(testDir, 'nonexistent.txt') });
    expect(result.type).toBe('error');
  });

  it('list_files should error on missing path', async () => {
    const result = await executeToolCall('list_files', { path: join(testDir, 'nonexistent') });
    expect(result.type).toBe('error');
  });

  it('search_in_files should find pattern', async () => {
    const result = await executeToolCall('search_in_files', { path: testDir, pattern: 'hello' });
    expect(result.type).toBe('success');
    expect(result.data.length).toBeGreaterThan(0);
    expect(result.data[0].file).toContain('test.txt');
  });

  it('search_in_files should return empty for non-matching pattern', async () => {
    const result = await executeToolCall('search_in_files', { path: testDir, pattern: 'zzzzzzzz' });
    expect(result.type).toBe('success');
    expect(result.data.length).toBe(0);
  });

  it('should return error for unknown tool', async () => {
    const result = await executeToolCall('unknown_tool', {});
    expect(result.type).toBe('error');
  });

  it('list_directory should return tree structure', async () => {
    const result = await executeToolCall('list_directory', { dir_path: testDir, max_depth: 2 });
    expect(result.type).toBe('success');
    expect(result.data.type).toBe('directory');
  });

  it('list_directory should return error when dir_path is missing', async () => {
    const result = await executeToolCall('list_directory', {});
    expect(result.type).toBe('error');
    expect(result.data).toContain('dir_path');
  });

  it('read_file should return error when file_path is missing', async () => {
    const result = await executeToolCall('read_file', {});
    expect(result.type).toBe('error');
    expect(result.data).toContain('file_path');
  });

  it('list_files should return error when path is missing', async () => {
    const result = await executeToolCall('list_files', {});
    expect(result.type).toBe('error');
    expect(result.data).toContain('path');
  });

  it('list_wiki_pages should return a result without crashing', async () => {
    const result = await executeToolCall('list_wiki_pages', {});
    expect(['success', 'error']).toContain(result.type);
  });

  it('read_wiki should return error when slug is missing', async () => {
    const result = await executeToolCall('read_wiki', {});
    expect(result.type).toBe('error');
    expect(result.data).toContain('slug');
  });

  it('read_wiki should handle nonexistent page gracefully', async () => {
    const result = await executeToolCall('read_wiki', { slug: 'nonexistent_page_xyz' });
    expect(['success', 'error']).toContain(result.type);
  });
});
