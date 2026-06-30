import { describe, it, expect } from '@jest/globals';
import type { SystemBlock } from './body';
import {
  relocateSystemContent,
  prependMovedContentToFirstUserMessage,
  OPENCODE_SYSTEM_FINGERPRINTS,
} from './classifier-scrub';

describe('relocateSystemContent', () => {
  it('B1: keeps non-fingerprint plain text in kept', () => {
    const out = relocateSystemContent('Answer tersely.', {});
    expect(out.kept.map((b: SystemBlock) => b.text)).toEqual(['Answer tersely.']);
    expect(out.moved).toBe('');
  });

  it('B2: relocates content matching /\\bopencode\\b/i', () => {
    const out = relocateSystemContent('You are OpenCode, the best agent.', {});
    expect(out.kept).toEqual([]);
    expect(out.moved).toContain('You are OpenCode');
    expect(out.moved).toContain('[moved from system]');
  });

  it('B3: relocates on /Workspace root folder/', () => {
    const out = relocateSystemContent('Workspace root folder: /home/user.', {});
    expect(out.kept).toEqual([]);
    expect(out.moved).toContain('Workspace root folder');
  });

  it('B4: relocates on /TodoWrite/', () => {
    const out = relocateSystemContent('Use TodoWrite to manage tasks.', {});
    expect(out.kept).toEqual([]);
    expect(out.moved).toContain('TodoWrite');
  });

  it('B5: relocates on /<directories>/', () => {
    const out = relocateSystemContent('Available <directories> at /tmp', {});
    expect(out.kept).toEqual([]);
    expect(out.moved).toContain('<directories>');
  });

  it('B6: relocates on /anomalyco/', () => {
    const out = relocateSystemContent('Source: github.com/anomalyco/opencode', {});
    expect(out.kept).toEqual([]);
    expect(out.moved).toContain('anomalyco');
  });

  it('B7: relocates on /is a git repo:/i', () => {
    const out = relocateSystemContent('This is a git repo: yes.', {});
    expect(out.kept).toEqual([]);
    expect(out.moved).toContain('is a git repo');
  });

  it('B8: oversized clean text (3001 chars) STAYS in kept (no length-only rule)', () => {
    const big = 'a'.repeat(3001);
    const out = relocateSystemContent(big, {});
    expect(out.kept.length).toBe(1);
    expect(out.kept[0]!.text).toBe(big);
    expect(out.moved).toBe('');
  });

  it('B9: array of blocks — mixed clean and fingerprint-bearing', () => {
    const sys: SystemBlock[] = [
      { type: 'text', text: 'You must be concise.' },
      { type: 'text', text: 'Workspace root folder: /foo' },
    ];
    const out = relocateSystemContent(sys, {});
    expect(out.kept.length).toBe(1);
    expect(out.kept[0]!.text).toBe('You must be concise.');
    expect(out.moved).toContain('Workspace root folder');
  });

  it('B10: array of blocks — preserves cache_control on kept blocks', () => {
    const sys: SystemBlock[] = [
      { type: 'text', text: 'Stable instruction.', cache_control: { type: 'ephemeral', ttl: '1h' } },
      { type: 'text', text: 'OpenCode stuff' },
    ];
    const out = relocateSystemContent(sys, {});
    expect(out.kept[0]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(out.moved).toContain('OpenCode stuff');
  });

  it('B11: idempotency — content already prefixed with marker is not double-prefixed', () => {
    const sys: SystemBlock[] = [
      { type: 'text', text: '[moved from system]\nYou are OpenCode.' },
      { type: 'text', text: 'OpenCode workspace root: /foo' },
    ];
    const out = relocateSystemContent(sys, {});
    const occurrences = (out.moved.match(/\[moved from system\]/g) || []).length;
    expect(occurrences).toBe(1);
  });

  it('B12: strips pre-existing identity/billing blocks before classifying', () => {
    const sys: SystemBlock[] = [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.196.aaa; cc_entrypoint=cli; cch=00000;' },
      { type: 'text', text: 'You are Claude Code, Anthropic\'s official CLI for Claude.' },
      { type: 'text', text: 'Workspace root folder: /foo' },
    ];
    const out = relocateSystemContent(sys, {});
    // billing + identity were stripped (not classified as fingerprint-bearing)
    // only the opencode fingerprint block should be in `moved`
    expect(out.moved).toContain('Workspace root folder');
    expect(out.moved).not.toContain('x-anthropic-billing-header');
    expect(out.moved).not.toContain('Claude Code, Anthropic');
  });

  it('B13: undefined / null / non-array / non-string input is tolerated', () => {
    expect(relocateSystemContent(undefined, {}).moved).toBe('');
    expect(relocateSystemContent(null, {}).kept).toEqual([]);
    expect(relocateSystemContent(42, {}).kept).toEqual([]);
    expect(relocateSystemContent({}, {}).kept).toEqual([]);
  });

  it('B14: fingerprint constants exported and count is 6', () => {
    expect(OPENCODE_SYSTEM_FINGERPRINTS.length).toBe(6);
    for (const r of OPENCODE_SYSTEM_FINGERPRINTS) expect(r).toBeInstanceOf(RegExp);
  });

  it('B15: custom marker option is respected', () => {
    const out = relocateSystemContent('OpenCode stuff', { marker: '[relocated]' });
    expect(out.moved).toContain('[relocated]');
    expect(out.moved).not.toContain('[moved from system]');
  });
});

describe('prependMovedContentToFirstUserMessage', () => {
  it('P1: string content — prepends moved text + \\n\\n', () => {
    const body = { messages: [{ role: 'user', content: 'Hello' }] };
    const out = prependMovedContentToFirstUserMessage(body, 'MOVED', {});
    const msgs = out.messages as Array<Record<string, unknown>>;
    expect(msgs[0]!.content).toBe('MOVED\n\nHello');
  });

  it('P2: array content — unshifts {type: text, text: moved} block', () => {
    const body = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
      ],
    };
    const out = prependMovedContentToFirstUserMessage(body, 'MOVED', {});
    const msg = (out.messages as Array<Record<string, unknown>>)[0]!;
    const content = msg.content as Array<Record<string, unknown>>;
    expect(content.length).toBe(2);
    expect(content[0]).toEqual({ type: 'text', text: 'MOVED' });
    expect(content[1]!.text).toBe('Hi');
  });

  it('P3: empty messages → appends synthetic user message', () => {
    const body = { messages: [] };
    const out = prependMovedContentToFirstUserMessage(body, 'MOVED', {});
    const msgs = out.messages as Array<Record<string, unknown>>;
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.role).toBe('user');
    expect(msgs[0]!.content).toBe('MOVED');
  });

  it('P4: messages absent → adds messages array with synthetic user', () => {
    const body = {};
    const out = prependMovedContentToFirstUserMessage(body, 'MOVED', {});
    const msgs = out.messages as Array<Record<string, unknown>>;
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.role).toBe('user');
    expect(msgs[0]!.content).toBe('MOVED');
  });

  it('P5: first message is assistant → still finds first user (or appends synthetic if none)', () => {
    const body = {
      messages: [
        { role: 'assistant', content: 'I am ready.' },
        { role: 'user', content: 'Go.' },
      ],
    };
    const out = prependMovedContentToFirstUserMessage(body, 'MOVED', {});
    const msgs = out.messages as Array<Record<string, unknown>>;
    expect(msgs[1]!.content).toBe('MOVED\n\nGo.');
    expect(msgs[0]!.content).toBe('I am ready.');
  });

  it('P6: no user message anywhere → appends synthetic user at end', () => {
    const body = {
      messages: [{ role: 'assistant', content: 'I am ready.' }],
    };
    const out = prependMovedContentToFirstUserMessage(body, 'MOVED', {});
    const msgs = out.messages as Array<Record<string, unknown>>;
    expect(msgs.length).toBe(2);
    expect(msgs[1]).toEqual({ role: 'user', content: 'MOVED' });
  });

  it('P7: idempotency — already-prefixed message is not double-prefixed', () => {
    const body = {
      messages: [
        { role: 'user', content: '[moved from system]\nOld content' },
      ],
    };
    const out = prependMovedContentToFirstUserMessage(body, 'MOVED', {});
    const msgs = out.messages as Array<Record<string, unknown>>;
    const occurrences = ((msgs[0]!.content as string).match(/\[moved from system\]/g) || []).length;
    expect(occurrences).toBe(1);
  });

  it('P8: does not mutate input body or messages array (immutability)', () => {
    const body = { messages: [{ role: 'user', content: 'Hi' }] };
    const snapshot = JSON.parse(JSON.stringify(body));
    prependMovedContentToFirstUserMessage(body, 'MOVED', {});
    expect(body).toEqual(snapshot);
  });

  it('P9: empty movedText is a no-op (returns body unchanged)', () => {
    const body = { messages: [{ role: 'user', content: 'Hi' }] };
    const out = prependMovedContentToFirstUserMessage(body, '', {});
    expect(out.messages).toEqual(body.messages);
  });
});
