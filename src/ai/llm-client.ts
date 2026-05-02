import type { ToolDefinition } from './tools.js';
import type { WikiCliConfig } from '../config/config-store.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  index?: number;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface StreamChunk {
  type: 'content' | 'reasoning' | 'tool_call' | 'done' | 'error';
  content?: string;
  reasoning_content?: string;
  tool_call?: ToolCall;
  error?: string;
}

export interface LLMResponse {
  content: string | null;
  reasoning_content?: string | null;
  tool_calls: ToolCall[];
}

const MAX_RETRIES = 3;

function serializeMessage(m: ChatMessage): Record<string, any> {
  const msg: Record<string, any> = { role: m.role };
  if (m.content !== undefined) msg.content = m.content;
  if (m.reasoning_content !== undefined && m.reasoning_content !== null) {
    msg.reasoning_content = m.reasoning_content;
  }
  if (m.tool_calls) msg.tool_calls = m.tool_calls;
  if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
  if (m.name) msg.name = m.name;
  if (msg.content === null) delete msg.content;
  return msg;
}

export function stripCodeFence(text: string): string {
  return text.replace(/^```(?:json)?\s*\n?/gm, '').replace(/\n?```\s*$/g, '').trim();
}

function buildRequest(config: WikiCliConfig, messages: ChatMessage[], tools?: ToolDefinition[], stream?: boolean, jsonMode?: boolean): { url: string; headers: Record<string, string>; body: string } {
  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body: Record<string, any> = {
    model: config.model,
    messages: messages.map(serializeMessage),
  };
  if (stream) body.stream = true;
  if (tools && tools.length > 0) body.tools = tools;
  if (jsonMode) {
    body.response_format = { type: 'json_object' };
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${config.apiKey}`,
  };

  return { url, headers, body: JSON.stringify(body) };
}

function isRetryable(status: number): boolean {
  return status >= 500 || status === 429;
}

async function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export class LLMClient {
  private config: WikiCliConfig;

  constructor(config: WikiCliConfig) {
    this.config = config;
  }

  async *chatStream(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    jsonMode?: boolean
  ): AsyncGenerator<StreamChunk> {
    const { url, headers, body: bodyStr } = buildRequest(this.config, messages, tools, true, jsonMode);
    let lastError: string | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const wait = Math.pow(2, attempt - 1) * 1000;
        yield { type: 'reasoning', reasoning_content: `\n[retry ${attempt}/${MAX_RETRIES} in ${wait}ms]` };
        await delay(wait);
      }

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: bodyStr,
        });

        if (!response.ok) {
          const errorText = await response.text();
          lastError = `API error ${response.status}: ${errorText}`;
          if (isRetryable(response.status)) {
            continue;
          }
          yield { type: 'error', error: lastError };
          return;
        }

        const reader = response.body?.getReader();
        if (!reader) {
          lastError = 'No response body';
          continue;
        }

        const decoder = new TextDecoder();
        let buffer = '';

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith('data: ')) continue;

              const data = trimmed.slice(6);
              if (data === '[DONE]') {
                yield { type: 'done' };
                return;
              }

              try {
                const parsed = JSON.parse(data);
                const delta = parsed.choices?.[0]?.delta;

                if (delta?.content) {
                  yield { type: 'content', content: delta.content };
                }

                if (delta?.reasoning_content) {
                  yield { type: 'reasoning', reasoning_content: delta.reasoning_content };
                }

                if (delta?.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    const toolCall: ToolCall = {
                      id: tc.id || '',
                      index: tc.index,
                      type: 'function',
                      function: {
                        name: tc.function?.name || '',
                        arguments: tc.function?.arguments || '',
                      },
                    };
                    yield { type: 'tool_call', tool_call: toolCall };
                  }
                }
              } catch {
                // skip malformed json
              }
            }
          }
        } catch (streamErr: any) {
          lastError = `Stream read error: ${streamErr.message}`;
          continue;
        }

        yield { type: 'done' };
        return;
      } catch (fetchErr: any) {
        lastError = `Network error: ${fetchErr.message}`;
        continue;
      }
    }

    yield { type: 'error', error: `Request failed after ${MAX_RETRIES + 1} attempts: ${lastError}` };
  }

  async chat(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    jsonMode?: boolean
  ): Promise<LLMResponse> {
    const { url, headers, body: bodyStr } = buildRequest(this.config, messages, tools, false, jsonMode);
    let lastError: string | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        await delay(Math.pow(2, attempt - 1) * 1000);
      }

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: bodyStr,
        });

        if (!response.ok) {
          const errorText = await response.text();
          lastError = `API error ${response.status}: ${errorText}`;
          if (isRetryable(response.status)) {
            continue;
          }
          throw new Error(lastError);
        }

        const result = await response.json();
        const choice = result.choices?.[0]?.message;
        return {
          content: choice?.content || null,
          reasoning_content: choice?.reasoning_content || null,
          tool_calls: choice?.tool_calls || [],
        };
      } catch (err: any) {
        lastError = err.message;
        if (attempt < MAX_RETRIES) continue;
        throw err;
      }
    }

    throw new Error(`Request failed after ${MAX_RETRIES + 1} attempts: ${lastError}`);
  }
}
