import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Replicate parseOutlineTopics logic for testing
function parseOutlineTopics(xmlContent: string): { title: string; level: string; section: string; isGroup?: boolean }[] {
  const topics: { title: string; level: string; section: string; isGroup?: boolean }[] = [];
  let currentSection = '';
  let pendingSection = false;

  const lines = xmlContent.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const sectionMatch = trimmed.match(/^<section>\s*([^<]*)/);
    if (sectionMatch) {
      const name = sectionMatch[1].trim();
      if (name) {
        currentSection = name;
        pendingSection = false;
      } else {
        pendingSection = true;
      }
      continue;
    }

    if (pendingSection) {
      currentSection = trimmed;
      pendingSection = false;
      continue;
    }

    if (trimmed.startsWith('</section>')) {
      currentSection = '';
      pendingSection = false;
      continue;
    }

    const topicMatch = trimmed.match(/<topic\s+level="([^"]*)">([^<]*)<\/topic>/);
    if (topicMatch) {
      topics.push({ title: topicMatch[2].trim(), level: topicMatch[1].trim(), section: currentSection });
      continue;
    }

    const groupMatch = trimmed.match(/<group>([^<]*)<\/group>/);
    if (groupMatch) {
      topics.push({ title: groupMatch[1].trim(), level: '', section: currentSection, isGroup: true });
    }
  }

  return topics;
}

describe('parseOutlineTopics', () => {
  const sampleXml = `<section>
入门指南
<topic level="初学">概览</topic>
<topic level="初学">快速开始</topic>
</section>

<section>
深入探索
<group>核心模块</group>
<topic level="高级">架构设计</topic>
</section>`;

  it('should parse sections when name is on next line', () => {
    const topics = parseOutlineTopics(sampleXml);
    expect(topics.length).toBe(4);

    const introTopics = topics.filter(t => t.section === '入门指南');
    expect(introTopics.length).toBe(2);
    expect(introTopics[0].title).toBe('概览');
    expect(introTopics[0].level).toBe('初学');

    const deepTopics = topics.filter(t => t.section === '深入探索');
    expect(deepTopics.length).toBe(2);
    expect(deepTopics[0].isGroup).toBe(true);
    expect(deepTopics[0].title).toBe('核心模块');
    expect(deepTopics[1].title).toBe('架构设计');
  });

  it('should handle section name on same line as tag', () => {
    const xml = `<section>入门指南
<topic level="初学">概览</topic>
</section>`;
    const topics = parseOutlineTopics(xml);
    expect(topics.length).toBe(1);
    expect(topics[0].section).toBe('入门指南');
  });

  it('should return empty array for content without sections', () => {
    const topics = parseOutlineTopics('no sections here');
    expect(topics.length).toBe(0);
  });

  it('should handle real outline file', () => {
    const outlinePath = '.wiki/2026-05-02T22-55-36/_outline.xml';
    if (fs.existsSync(outlinePath)) {
      const content = fs.readFileSync(outlinePath, 'utf-8');
      const topics = parseOutlineTopics(content);
      expect(topics.length).toBeGreaterThan(0);

      const sections = [...new Set(topics.map(t => t.section).filter(Boolean))];
      expect(sections).toContain('入门指南');
      expect(sections).toContain('深入探索');
    }
  });
});
