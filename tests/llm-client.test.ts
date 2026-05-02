import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LLMClient } from '../src/ai/llm-client.js';
import type { WikiCliConfig } from '../src/config/config-store.js';

const mockConfig: WikiCliConfig = {
  provider: 'test',
  baseUrl: 'https://api.test.com/v1',
  model: 'test-model',
  apiKey: 'sk-test',
  lang: 'zh',
};

function createMockStream(chunks: any[]) {
  const encoder = new TextEncoder();
  const lines = chunks.map(c => `data: ${JSON.stringify(c)}\n`);
  lines.push('data: [DONE]\n');
  const all = lines.join('');

  return {
    body: {
      getReader() {
        let pos = 0;
        return {
          read() {
            if (pos >= all.length) {
              return Promise.resolve({ done: true, value: undefined });
            }
            const chunk = all.slice(pos, pos + 50);
            pos += 50;
            return Promise.resolve({ done: false, value: encoder.encode(chunk) });
          },
        };
      },
    },
    ok: true,
  };
}

describe('LLMClient', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should create instance', () => {
    const client = new LLMClient(mockConfig);
    expect(client).toBeInstanceOf(LLMClient);
  });

  it('chatStream should yield content chunks', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      createMockStream([
        {
          choices: [{ delta: { content: 'Hello' }, index: 0 }],
        },
        {
          choices: [{ delta: { content: ' World' }, index: 0 }],
        },
      ])
    );

    const client = new LLMClient(mockConfig);
    const chunks: any[] = [];
    for await (const chunk of client.chatStream([{ role: 'user', content: 'hi' }])) {
      chunks.push(chunk);
    }

    expect(chunks.some(c => c.type === 'content' && c.content === 'Hello')).toBe(true);
    expect(chunks.some(c => c.type === 'done')).toBe(true);
  });

  it('chatStream should yield tool_call chunks', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      createMockStream([
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'test_tool', arguments: '{"key":"val"}' },
              }],
            },
            index: 0,
          }],
        },
        {
          choices: [{ delta: { content: 'Done' }, index: 0 }],
        },
      ])
    );

    const client = new LLMClient(mockConfig);
    const chunks: any[] = [];
    for await (const chunk of client.chatStream([{ role: 'user', content: 'use tool' }])) {
      chunks.push(chunk);
    }

    expect(chunks.some(c => c.type === 'tool_call')).toBe(true);
  });

  it('chatStream should yield error on non-ok response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    });

    const client = new LLMClient(mockConfig);
    const chunks: any[] = [];
    for await (const chunk of client.chatStream([{ role: 'user', content: 'hi' }])) {
      chunks.push(chunk);
    }

    expect(chunks.some(c => c.type === 'error')).toBe(true);
  });

  it('chat (non-streaming) should send correct request format', async () => {
    let requestBody: any = null;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, opts: any) => {
      requestBody = JSON.parse(opts.body);
      return {
        ok: true,
        json: () => Promise.resolve({
          choices: [{
            message: {
              content: 'Response content',
              tool_calls: [],
            },
          }],
        }),
      };
    });

    const client = new LLMClient(mockConfig);
    const result = await client.chat(
      [{ role: 'system', content: 'be helpful' }, { role: 'user', content: 'hello' }],
      [{ type: 'function', function: { name: 'test', description: 'test', parameters: { type: 'object', properties: {} } } }]
    );

    expect(result.content).toBe('Response content');
    expect(requestBody.model).toBe('test-model');
    expect(requestBody.messages.length).toBe(2);
    expect(requestBody.tools).toBeDefined();
    expect(requestBody.tools.length).toBe(1);
  });

  it('chatStream should yield reasoning chunks', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      createMockStream([
        {
          choices: [{ delta: { reasoning_content: 'Let me think step by step' }, index: 0 }],
        },
        {
          choices: [{ delta: { reasoning_content: ' about this problem' }, index: 0 }],
        },
        {
          choices: [{ delta: { content: 'Here is the answer' }, index: 0 }],
        },
      ])
    );

    const client = new LLMClient(mockConfig);
    const chunks: any[] = [];
    for await (const chunk of client.chatStream([{ role: 'user', content: 'think' }])) {
      chunks.push(chunk);
    }

    const reasoningChunks = chunks.filter(c => c.type === 'reasoning');
    expect(reasoningChunks.length).toBeGreaterThanOrEqual(2);
    expect(reasoningChunks[0].reasoning_content).toBe('Let me think step by step');
  });

  it('should send reasoning_content back in assistant messages', async () => {
    let requestBody: any = null;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: 'OK', tool_calls: [] } }],
      }),
    });

    const client = new LLMClient(mockConfig);
    await client.chat([
      {
        role: 'assistant',
        content: 'some content',
        reasoning_content: 'my reasoning chain',
      },
      { role: 'user', content: 'continue' },
    ]);

    expect(globalThis.fetch).toHaveBeenCalled();
    const call = (globalThis.fetch as any).mock.calls[0];
    requestBody = JSON.parse(call[1].body);
    const assistantMsg = requestBody.messages[0];
    expect(assistantMsg.role).toBe('assistant');
    expect(assistantMsg.reasoning_content).toBe('my reasoning chain');
  });

  it('should retry on 5xx error and succeed', async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: false, status: 503, text: () => Promise.resolve('Service Unavailable') };
      }
      return {
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: 'Retried success', tool_calls: [] } }],
        }),
      };
    });

    const client = new LLMClient(mockConfig);
    const result = await client.chat([{ role: 'user', content: 'hi' }]);
    expect(result.content).toBe('Retried success');
    expect(callCount).toBe(2);
  });

  it('should retry streaming on 5xx and succeed', async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: false, status: 502, text: () => Promise.resolve('Bad Gateway') };
      }
      const encoder = new TextEncoder();
      return {
        ok: true,
        body: {
          getReader() {
            let done = false;
            return {
              read() {
                if (done) return Promise.resolve({ done: true, value: undefined });
                done = true;
                const data = 'data: [DONE]\n';
                return Promise.resolve({ done: false, value: encoder.encode(data) });
              },
            };
          },
        },
      };
    });

    const client = new LLMClient(mockConfig);
    const chunks: any[] = [];
    for await (const chunk of client.chatStream([{ role: 'user', content: 'hi' }])) {
      chunks.push(chunk);
    }
    expect(chunks.some(c => c.type === 'done')).toBe(true);
    expect(callCount).toBe(2);
  });

  it('should retry on network error and eventually succeed', { timeout: 15000 }, async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) throw new Error('ECONNRESET');
      return {
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: 'OK after retries', tool_calls: [] } }],
        }),
      };
    });

    const client = new LLMClient(mockConfig);
    const result = await client.chat([{ role: 'user', content: 'hi' }]);
    expect(result.content).toBe('OK after retries');
    expect(callCount).toBe(3);
  });

  it('should not retry on 4xx error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    });

    const client = new LLMClient(mockConfig);
    const chunks: any[] = [];
    for await (const chunk of client.chatStream([{ role: 'user', content: 'hi' }])) {
      chunks.push(chunk);
    }
    expect(chunks.some(c => c.type === 'error')).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('should use correct baseUrl', async () => {
    let calledUrl = '';
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      calledUrl = url;
      return {
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: 'OK', tool_calls: [] } }],
        }),
      };
    });

    const client = new LLMClient(mockConfig);
    await client.chat([{ role: 'user', content: 'hi' }]);
    expect(calledUrl).toBe('https://api.test.com/v1/chat/completions');
  });
});
