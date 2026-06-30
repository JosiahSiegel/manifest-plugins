import { describe, it, expect } from '@jest/globals';
import {
  scrubAnchorsInPlace,
  OPENCODE_SCRUB_SUBSTITUTIONS,
} from './classifier-scrub';
import {
  normalizeToolNames,
  OPENCODE_TOOL_NAME_MAP,
} from './tool-normalization';

describe('scrubAnchorsInPlace', () => {
  it('S7-1: rewrites github.com/anomalyco/opencode URL in system[]', () => {
    const body = {
      system: 'Report issues at https://github.com/anomalyco/opencode',
      messages: [{ role: 'user', content: 'Hi' }],
    };
    const out = scrubAnchorsInPlace(body, { scrubMessages: false });
    const sys = out['system'] as string;
    expect(sys).toContain('github.com/anthropics/claude-code');
    expect(sys).not.toContain('anomalyco');
  });

  it('S7-2: rewrites opencode.ai/docs URL in system[]', () => {
    const body = {
      system: 'See https://opencode.ai/docs for details',
      messages: [],
    };
    const out = scrubAnchorsInPlace(body, { scrubMessages: false });
    const sys = out['system'] as string;
    expect(sys).toContain('docs.claude.com/en/docs/claude-code');
    expect(sys).not.toContain('opencode.ai/docs');
  });

  it('S7-3: rewrites "You are OpenCode" exact phrase', () => {
    const body = {
      system: 'You are OpenCode, the best coding agent on the planet.',
      messages: [],
    };
    const out = scrubAnchorsInPlace(body, { scrubMessages: false });
    const sys = out['system'] as string;
    expect(sys).toContain('You are Claude Code, Anthropic\'s official CLI for Claude');
    expect(sys).not.toContain('You are OpenCode');
  });

  it('S7-4: rewrites Workspace root folder label', () => {
    const body = {
      system: 'Workspace root folder: /home/user/foo',
      messages: [],
    };
    const out = scrubAnchorsInPlace(body, { scrubMessages: false });
    const sys = out['system'] as string;
    expect(sys).toContain('Working directory:');
    expect(sys).not.toContain('Workspace root folder:');
  });

  it('S7-5: rewrites "Is directory a git repo:" label (capital I variant)', () => {
    const body = {
      system: 'Is directory a git repo: yes',
      messages: [],
    };
    const out = scrubAnchorsInPlace(body, { scrubMessages: false });
    const sys = out['system'] as string;
    expect(sys).toContain('Git repository:');
    expect(sys).not.toContain('Is directory a git repo');
  });

  it('S7-6: rewrites <directories> XML marker', () => {
    const body = {
      system: '<directories>foo, bar</directories>',
      messages: [],
    };
    const out = scrubAnchorsInPlace(body, { scrubMessages: false });
    const sys = out['system'] as string;
    expect(sys).toContain('<project_files>');
    expect(sys).toContain('</project_files>');
    expect(sys).not.toContain('<directories>');
  });

  it('S7-7: rewrites "Here is some useful information about the environment" phrase (ex-machina v1.7.5 signal)', () => {
    const body = {
      system: 'Here is some useful information about the environment you are running in:',
      messages: [],
    };
    const out = scrubAnchorsInPlace(body, { scrubMessages: false });
    const sys = out['system'] as string;
    expect(sys).toContain('Environment context:');
    expect(sys).not.toContain('Here is some useful information about the environment');
  });

  it('S7-8: does NOT rewrite TodoWrite (same real tool name in both)', () => {
    const body = {
      system: 'You have access to the TodoWrite tool to track tasks.',
      messages: [],
    };
    const out = scrubAnchorsInPlace(body, { scrubMessages: false });
    const sys = out['system'] as string;
    expect(sys).toContain('TodoWrite');
  });

  it('S7-9: rewrites system[] array blocks (text blocks)', () => {
    const body = {
      system: [
        { type: 'text', text: 'Workspace root folder: /foo' },
        { type: 'text', text: 'You are OpenCode, the best coding agent on the planet.' },
      ],
      messages: [],
    };
    const out = scrubAnchorsInPlace(body, { scrubMessages: false });
    const sys = out['system'] as Array<Record<string, unknown>>;
    expect(sys[0]!.text).toContain('Working directory:');
    expect(sys[1]!.text).toContain("You are Claude Code, Anthropic's official CLI for Claude");
  });

  it('S7-10: preserves cache_control on scrubbed system[] blocks', () => {
    const body = {
      system: [
        {
          type: 'text',
          text: 'Workspace root folder: /foo',
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ],
      messages: [],
    };
    const out = scrubAnchorsInPlace(body, { scrubMessages: false });
    const sys = out['system'] as Array<Record<string, unknown>>;
    expect(sys[0]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('S7-11: rewrites messages[] string content when scrubMessages=true', () => {
    const body = {
      system: 'You are Claude Code.',
      messages: [{ role: 'user', content: 'Workspace root folder: /foo bar' }],
    };
    const out = scrubAnchorsInPlace(body, { scrubMessages: true });
    const msgs = out['messages'] as Array<Record<string, unknown>>;
    expect(msgs[0]!.content).toContain('Working directory:');
  });

  it('S7-12: does NOT rewrite messages[] when scrubMessages=false', () => {
    const body = {
      system: 'You are Claude Code.',
      messages: [{ role: 'user', content: 'Workspace root folder: /foo' }],
    };
    const out = scrubAnchorsInPlace(body, { scrubMessages: false });
    const msgs = out['messages'] as Array<Record<string, unknown>>;
    expect(msgs[0]!.content).toContain('Workspace root folder:');
  });

  it('S7-13: rewrites messages[] array content text blocks, skips tool_use/tool_result/image blocks', () => {
    const body = {
      system: 'You are Claude Code.',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Workspace root folder: /foo' },
            {
              type: 'tool_use',
              id: 'tu_1',
              name: 'bash',
              input: { command: 'ls' },
            },
            {
              type: 'tool_result',
              tool_use_id: 'tu_1',
              content: 'Workspace root folder: leaked',
            },
            {
              type: 'image',
              source: { type: 'base64', data: 'xxx' },
            },
          ],
        },
      ],
    };
    const out = scrubAnchorsInPlace(body, { scrubMessages: true });
    const msgs = out['messages'] as Array<Record<string, unknown>>;
    const content = msgs[0]!.content as Array<Record<string, unknown>>;
    expect(content[0]!.text).toContain('Working directory:');
    expect(content[1]).toEqual({
      type: 'tool_use',
      id: 'tu_1',
      name: 'bash',
      input: { command: 'ls' },
    });
    expect((content[2]!.content as string)).toContain('Workspace root folder:');
    expect(content[3]).toEqual({
      type: 'image',
      source: { type: 'base64', data: 'xxx' },
    });
  });

  it('S7-14: rewrites assistant messages too (not just user)', () => {
    const body = {
      system: 'You are Claude Code.',
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Workspace root folder: /foo bar' },
      ],
    };
    const out = scrubAnchorsInPlace(body, { scrubMessages: true });
    const msgs = out['messages'] as Array<Record<string, unknown>>;
    expect(msgs[1]!.content).toContain('Working directory:');
  });

  it('S7-15: does not mutate input body (immutability)', () => {
    const body = {
      system: 'Workspace root folder: /foo',
      messages: [{ role: 'user', content: 'Workspace root folder: bar' }],
    };
    const snapshot = JSON.parse(JSON.stringify(body));
    scrubAnchorsInPlace(body, { scrubMessages: true });
    expect(body).toEqual(snapshot);
  });

  it('S7-16: tolerant of weird inputs (no throw)', () => {
    expect(() => scrubAnchorsInPlace({}, { scrubMessages: true })).not.toThrow();
    expect(() => scrubAnchorsInPlace({ system: null, messages: 'bad' }, { scrubMessages: true })).not.toThrow();
    expect(() => scrubAnchorsInPlace({ system: 42, messages: [{ role: 'user' }] }, { scrubMessages: true })).not.toThrow();
  });

  it('S7-17: SUBSTITUTIONS exported as constant', () => {
    expect(OPENCODE_SCRUB_SUBSTITUTIONS.length).toBeGreaterThan(0);
    for (const s of OPENCODE_SCRUB_SUBSTITUTIONS) {
      expect(s.from).toBeInstanceOf(RegExp);
      expect(typeof s.to).toBe('string');
    }
  });
});

describe('normalizeToolNames', () => {
  it('S7-20: renames top-level tools[] array (lowercase → PascalCase)', () => {
    const body = {
      tools: [
        { name: 'read', description: 'Read a file', input_schema: { type: 'object' } },
        { name: 'bash', description: 'Run a command', input_schema: { type: 'object' } },
      ],
      messages: [],
    };
    const out = normalizeToolNames(body);
    const tools = out['tools'] as Array<Record<string, unknown>>;
    expect(tools[0]!.name).toBe('Read');
    expect(tools[1]!.name).toBe('Bash');
  });

  it('S7-21: renames all native tools in the registry', () => {
    const body = {
      tools: [
        { name: 'read', description: '' },
        { name: 'write', description: '' },
        { name: 'edit', description: '' },
        { name: 'glob', description: '' },
        { name: 'grep', description: '' },
        { name: 'webfetch', description: '' },
        { name: 'websearch', description: '' },
        { name: 'todowrite', description: '' },
        { name: 'bash', description: '' },
        { name: 'lsp', description: '' },
        { name: 'skill', description: '' },
        { name: 'question', description: '' },
      ],
      messages: [],
    };
    const out = normalizeToolNames(body);
    const tools = out['tools'] as Array<Record<string, unknown>>;
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'AskUserQuestion', 'Bash', 'Edit', 'Glob', 'Grep', 'LSP', 'Read', 'Skill', 'TodoWrite',
      'WebFetch', 'WebSearch', 'Write',
    ]);
  });

  it('S7-22: leaves unknown tool names untouched (no false positives)', () => {
    const body = {
      tools: [
        { name: 'custom_tool', description: 'Custom' },
        { name: 'apply_patch', description: 'Apply a patch' },
        { name: 'invalid', description: 'Invalid tool' },
      ],
      messages: [],
    };
    const out = normalizeToolNames(body);
    const tools = out['tools'] as Array<Record<string, unknown>>;
    expect(tools[0]!.name).toBe('custom_tool');
    expect(tools[1]!.name).toBe('apply_patch');
    expect(tools[2]!.name).toBe('invalid');
  });

  it('S7-23: renames assistant tool_use.name in messages[]', () => {
    const body = {
      tools: [{ name: 'read', description: '' }],
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'read', input: { path: '/foo' } },
          ],
        },
      ],
    };
    const out = normalizeToolNames(body);
    const msgs = out['messages'] as Array<Record<string, unknown>>;
    const content = msgs[0]!.content as Array<Record<string, unknown>>;
    expect(content[0]!.name).toBe('Read');
    expect(content[0]!.id).toBe('tu_1');
  });

  it('S7-24: renames tool_choice.name (auto, any, specific)', () => {
    const body = {
      tools: [{ name: 'read', description: '' }],
      tool_choice: { type: 'tool', name: 'read' },
      messages: [],
    };
    const out = normalizeToolNames(body);
    const choice = out['tool_choice'] as Record<string, unknown>;
    expect(choice.name).toBe('Read');
  });

  it('S7-25: leaves tool_use_id and tool_result blocks untouched (only renames tool_use.name)', () => {
    const body = {
      tools: [{ name: 'read', description: '' }],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_1',
              content: 'file contents',
            },
          ],
        },
      ],
    };
    const out = normalizeToolNames(body);
    const msgs = out['messages'] as Array<Record<string, unknown>>;
    const content = msgs[0]!.content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'tu_1',
      content: 'file contents',
    });
  });

  it('S7-26: does not mutate input body', () => {
    const body = {
      tools: [{ name: 'read', description: '' }],
      messages: [],
    };
    const snapshot = JSON.parse(JSON.stringify(body));
    normalizeToolNames(body);
    expect(body).toEqual(snapshot);
  });

  it('S7-27: tolerant of missing tools field', () => {
    const body = { messages: [] };
    const out = normalizeToolNames(body);
    expect(out).toEqual({ messages: [] });
  });

  it('S7-28: TOOL_NAME_MAP exported as constant (lowercase → PascalCase)', () => {
    expect(OPENCODE_TOOL_NAME_MAP.get('read')).toBe('Read');
    expect(OPENCODE_TOOL_NAME_MAP.get('bash')).toBe('Bash');
    expect(OPENCODE_TOOL_NAME_MAP.get('edit')).toBe('Edit');
    expect(OPENCODE_TOOL_NAME_MAP.size).toBeGreaterThanOrEqual(10);
  });
});