// =============================================================================
// Tool-name normalization
// =============================================================================
//
// opencode registers native tools with lowercase IDs ("read", "bash", "edit", ...).
// Claude Code uses PascalCase ("Read", "Bash", "Edit", ...). Anthropic's classifier
// appears to expect Claude Code's casing for OAuth subscription tool access.
//
// Renaming on the REQUEST side is safe: opencode's experimental_repairToolCall
// (session/llm.ts:297-301) auto-heals response-side PascalCase → lowercase
// mismatches. See opencode PR #15049.
//
// Only NATIVE tools are renamed. MCP tools are left unchanged (their naming
// depends on per-server sanitization and is ambiguous). Unknown tools (custom
// plugins, apply_patch, invalid) are left untouched.

export const OPENCODE_TOOL_NAME_MAP: ReadonlyMap<string, string> = new Map<string, string>([
  ['bash', 'Bash'],
  ['read', 'Read'],
  ['write', 'Write'],
  ['edit', 'Edit'],
  ['glob', 'Glob'],
  ['grep', 'Grep'],
  ['webfetch', 'WebFetch'],
  ['websearch', 'WebSearch'],
  ['todowrite', 'TodoWrite'],
  ['lsp', 'LSP'],
  ['skill', 'Skill'],
  ['question', 'AskUserQuestion'],
]);

export function normalizeToolNames(
  requestBody: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...requestBody };

  // 1. Top-level tools[] array
  const tools = out['tools'];
  if (Array.isArray(tools)) {
    out['tools'] = tools.map((t) => renameToolDefinition(t));
  }

  // 2. tool_choice.name
  const choice = out['tool_choice'];
  if (choice && typeof choice === 'object' && !Array.isArray(choice)) {
    const c = choice as Record<string, unknown>;
    const renamed = maybeRenameToolName(c['name']);
    if (renamed !== undefined) {
      out['tool_choice'] = { ...c, name: renamed };
    }
  }

  // 3. Assistant tool_use.name in messages[]
  const messages = out['messages'];
  if (Array.isArray(messages)) {
    out['messages'] = messages.map((m) => renameToolUseInMessage(m));
  }

  return out;
}

function renameToolDefinition(t: unknown): unknown {
  if (typeof t !== 'object' || t === null || Array.isArray(t)) return t;
  const td = { ...(t as Record<string, unknown>) };
  const renamed = maybeRenameToolName(td['name']);
  if (renamed !== undefined) {
    td['name'] = renamed;
  }
  return td;
}

function renameToolUseInMessage(m: unknown): unknown {
  if (typeof m !== 'object' || m === null || Array.isArray(m)) return m;
  const msg = { ...(m as Record<string, unknown>) };
  const content = msg['content'];
  if (!Array.isArray(content)) return msg;
  msg['content'] = content.map((block) => {
    if (typeof block !== 'object' || block === null || Array.isArray(block)) return block;
    const b = block as Record<string, unknown>;
    if (b['type'] === 'tool_use') {
      const renamed = maybeRenameToolName(b['name']);
      if (renamed !== undefined) {
        return { ...b, name: renamed };
      }
    }
    return block;
  });
  return msg;
}

function maybeRenameToolName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const mapped = OPENCODE_TOOL_NAME_MAP.get(value);
  return mapped; // undefined if not in the registry (e.g., MCP tools, apply_patch)
}