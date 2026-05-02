# Wiki CLI

Auto-generate structured Wiki documentation for any local code repository using LLM.

## Features

- `wiki-cli config` – Interactive configuration of LLM provider, model, API key, language
- `wiki-cli generate` – Analyze current repository, generate Wiki with streaming progress display, supports resume on interrupt
- `wiki-cli browse` – Serve generated Wiki in browser with sidebar navigation and Markdown rendering

## Installation

```bash
npm install -g wiki-cli
```

Or run directly:

```bash
npx wiki-cli --help
```

## Usage

### 1. Configure

```bash
wiki-cli config
```

Follow the interactive prompts to select:
- LLM provider (OpenAI, Google Gemini, Anthropic, xAI Grok, DeepSeek, Kimi, Mistral, or Custom)
- Model
- API key
- Documentation language

You can also pass all options as CLI flags:

```bash
wiki-cli config --provider DeepSeek --model deepseek-v4-flash --api-key sk-your-key --lang zh
```

### 2. Generate Wiki

```bash
wiki-cli generate
```

The tool will:
1. Analyze the current directory repository structure
2. Generate a documentation outline using LLM with tool calls
3. Generate individual pages for each topic
4. Save output to `.wiki/<timestamp>/`

If interrupted, re-run `wiki-cli generate` to resume from checkpoint.

### 3. Browse

```bash
wiki-cli browse
```

Opens the latest generated Wiki in your default browser with:
- Left sidebar: table of contents
- Right pane: rendered Markdown with syntax highlighting

## Project Structure

```
wiki-cli/
├── src/
│   ├── cli.ts                   # CLI entry point
│   ├── commands/
│   │   ├── config.ts            # Interactive config
│   │   ├── generate.ts          # Wiki generation flow
│   │   └── browse.ts            # Local Wiki browser
│   ├── ai/
│   │   ├── llm-client.ts        # OpenAI-compatible LLM client
│   │   ├── tools.ts             # Read-only tools for LLM
│   │   └── prompts.ts           # Prompt template engine
│   ├── utils/
│   │   ├── file.ts              # File system helpers
│   │   └── progress.ts          # Spinner & logging
│   └── config/
│       ├── default-models.json  # Built-in model list
│       └── config-store.ts      # Config persistence
├── prompts/                     # Prompt templates (decoupled)
├── tests/                       # Unit tests (vitest)
└── package.json
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Watch tests
npm run test:watch
```

## Configuration

Saved to `~/.wiki-cli/config.json`:

```json
{
  "provider": "DeepSeek",
  "baseUrl": "https://api.deepseek.com",
  "model": "deepseek-v4-flash",
  "apiKey": "sk-...",
  "lang": "zh"
}
```

## Supported LLM Providers

| Provider | Models |
|----------|--------|
| OpenAI | gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.4-nano, gpt-5-mini |
| Google Gemini | gemini-3.1-pro, gemini-3-flash, gemini-3.1-flash-lite |
| Anthropic | claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5 |
| xAI Grok | grok-4.3, grok-4.20-reasoning, grok-4-1-fast-reasoning |
| DeepSeek | deepseek-v4-pro, deepseek-v4-flash |
| Kimi (Moonshot) | kimi-k2.6, kimi-k2.5 |
| Mistral | mistral-large-3, devstral-2, ministral-14b |

Custom providers/models are also supported.

## Cross-Platform

Works on Windows, macOS, and Linux.
