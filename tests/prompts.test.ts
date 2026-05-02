import { describe, it, expect } from 'vitest';
import { fillPrompt } from '../src/ai/prompts.js';

describe('fillPrompt', () => {
  it('should replace single variable', () => {
    const result = fillPrompt('Hello {{name}}', { name: 'World' });
    expect(result).toBe('Hello World');
  });

  it('should replace multiple variables', () => {
    const result = fillPrompt('{{greeting}}, {{name}}!', { greeting: 'Hi', name: 'Alice' });
    expect(result).toBe('Hi, Alice!');
  });

  it('should replace same variable in multiple places', () => {
    const result = fillPrompt('{{x}} + {{x}} = {{y}}', { x: '2', y: '4' });
    expect(result).toBe('2 + 2 = 4');
  });

  it('should leave unreplaced variables as-is', () => {
    const result = fillPrompt('Hello {{name}}', {});
    expect(result).toBe('Hello {{name}}');
  });

  it('should handle empty template', () => {
    const result = fillPrompt('', { a: 'b' });
    expect(result).toBe('');
  });

  it('should handle empty vars object', () => {
    const result = fillPrompt('static text', {});
    expect(result).toBe('static text');
  });

  it('should handle Chinese variable values', () => {
    const result = fillPrompt('语言：{{lang}}', { lang: '中文' });
    expect(result).toBe('语言：中文');
  });
});
