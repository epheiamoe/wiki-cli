import { describe, it, expect } from 'vitest';
import { stripCodeFence } from '../src/ai/llm-client.js';

function parseOutlineJson(text: string): { title: string; level: string; section: string; brief?: string; isGroup?: boolean }[] {
  let cleaned = stripCodeFence(text);
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return [];

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.sections || !Array.isArray(parsed.sections)) return [];

    const topics: any[] = [];

    for (const section of parsed.sections) {
      const sectionName = section.name || '';
      if (!section.topics || !Array.isArray(section.topics)) continue;

      for (const item of section.topics) {
        if (item.type === 'group') {
          topics.push({ title: item.title, level: '', section: sectionName, isGroup: true });
        } else {
          topics.push({ title: item.title, level: item.level || '中级', section: sectionName, brief: item.brief || '' });
        }
      }
    }

    return topics;
  } catch {
    return [];
  }
}

describe('parseOutlineJson', () => {
  const sampleJson = `{
    "sections": [
      {
        "name": "入门指南",
        "topics": [
          { "level": "初学", "title": "概览", "brief": "项目定位与核心功能" },
          { "level": "初学", "title": "快速开始", "brief": "5 分钟体验" }
        ]
      },
      {
        "name": "深入探索",
        "topics": [
          { "type": "group", "title": "核心模块" },
          { "level": "高级", "title": "架构设计", "brief": "分层架构解析" }
        ]
      }
    ]
  }`;

  it('should parse sections and topics from JSON', () => {
    const topics = parseOutlineJson(sampleJson);
    expect(topics.length).toBe(4);

    const introTopics = topics.filter(t => t.section === '入门指南');
    expect(introTopics.length).toBe(2);
    expect(introTopics[0].title).toBe('概览');
    expect(introTopics[0].level).toBe('初学');
    expect(introTopics[0].brief).toBe('项目定位与核心功能');

    const deepTopics = topics.filter(t => t.section === '深入探索');
    expect(deepTopics.length).toBe(2);
    expect(deepTopics[0].isGroup).toBe(true);
    expect(deepTopics[0].title).toBe('核心模块');
    expect(deepTopics[1].title).toBe('架构设计');
  });

  it('should handle JSON wrapped in code fence', () => {
    const fenced = '```json\n' + sampleJson + '\n```';
    const topics = parseOutlineJson(fenced);
    expect(topics.length).toBe(4);
  });

  it('should handle JSON with extra text before/after', () => {
    const extra = 'Here is the result:\n\n' + sampleJson + '\n\nEnd.';
    const topics = parseOutlineJson(extra);
    expect(topics.length).toBe(4);
  });

  it('should return empty array for invalid input', () => {
    expect(parseOutlineJson('not json').length).toBe(0);
    expect(parseOutlineJson('').length).toBe(0);
    expect(parseOutlineJson('{"wrong": "structure"}').length).toBe(0);
  });

  it('should extract brief from topics', () => {
    const topics = parseOutlineJson(sampleJson);
    expect(topics[0].brief).toBe('项目定位与核心功能');
    expect(topics[1].brief).toBe('5 分钟体验');
  });

  it('should handle topics without brief field', () => {
    const json = `{"sections":[{"name":"入门指南","topics":[{"level":"初学","title":"概览"}]}]}`;
    const topics = parseOutlineJson(json);
    expect(topics.length).toBe(1);
    expect(topics[0].brief).toBe('');
  });
});

describe('stripCodeFence', () => {
  it('should remove ```json code fence', () => {
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('should remove ``` code fence', () => {
    expect(stripCodeFence('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('should return original if no fence', () => {
    expect(stripCodeFence('{"a":1}')).toBe('{"a":1}');
  });
});
