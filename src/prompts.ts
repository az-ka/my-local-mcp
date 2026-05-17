/**
 * MCP Prompts registration.
 *
 * Why: Prompts surface as slash-commands in clients. They package multi-step
 * workflows the user would otherwise have to type from scratch. Each prompt
 * returns a single `user` message body containing the orchestration prose.
 *
 * Each prompt is intentionally short. It nudges the model toward the right
 * tools without over-specifying steps — the model still chooses the path.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerPrompts(server: McpServer): void {
  // ─ explore-repo ────────────────────────────────────────────
  server.registerPrompt(
    'explore-repo',
    {
      title: 'Explore a repository',
      description: 'Bootstrap a brief tour of a tracked repo: README, tree, key entry points.',
      argsSchema: {
        repo: z.string().describe('Repo name (from list_repos)'),
        focus: z.string().optional().describe('Optional topic to bias the tour (e.g. "auth", "database")'),
      },
    },
    ({ repo, focus }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text:
            `Give me a concise tour of the repository "${repo}".\n` +
            `1. Call find_docs to surface the README + key docs.\n` +
            `2. Call get_tree with max_depth=2 to map structure.\n` +
            `3. Identify entry points and core modules.\n` +
            (focus ? `4. Bias the tour toward: ${focus}.\n` : '') +
            `\nReturn: a short overview, then a list of files I should read next, ranked by importance.`,
        },
      }],
    }),
  );

  // ─ find-impl ───────────────────────────────────────────────
  server.registerPrompt(
    'find-impl',
    {
      title: 'Find a symbol implementation',
      description: 'Locate where a function/class/type is defined, then read the surrounding block.',
      argsSchema: {
        repo: z.string().describe('Repo name'),
        symbol: z.string().describe('Symbol name (identifier)'),
      },
    },
    ({ repo, symbol }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text:
            `Find the implementation of \`${symbol}\` in "${repo}".\n` +
            `1. Call find_symbol(repo="${repo}", name="${symbol}").\n` +
            `2. For the most likely definition, call read_file with function_at_line set to the matching line.\n` +
            `3. If multiple plausible defs exist, summarize each and ask me which one.`,
        },
      }],
    }),
  );

  // ─ find-callers ────────────────────────────────────────────
  server.registerPrompt(
    'find-callers',
    {
      title: 'Find callers / usages',
      description: 'Locate every reference to a symbol, excluding the definition.',
      argsSchema: {
        repo: z.string().describe('Repo name'),
        symbol: z.string().describe('Symbol identifier'),
      },
    },
    ({ repo, symbol }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text:
            `Find every caller of \`${symbol}\` in "${repo}".\n` +
            `Call find_references(repo="${repo}", name="${symbol}", exclude_definitions=true, exclude_comments_and_strings=true).\n` +
            `Group results by file and tell me which file uses it most.`,
        },
      }],
    }),
  );

  // ─ changes-since ───────────────────────────────────────────
  server.registerPrompt(
    'changes-since',
    {
      title: 'Changes since a ref',
      description: 'Summarize commits + diff stat since a given branch/tag/commit.',
      argsSchema: {
        repo: z.string().describe('Repo name'),
        since: z.string().describe('A ref (branch, tag, or "2 weeks ago")'),
      },
    },
    ({ repo, since }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text:
            `Summarize what changed in "${repo}" since ${since}.\n` +
            `1. If \`${since}\` looks like a date phrase, call git_log(name="${repo}", since="${since}", limit=30).\n` +
            `2. Otherwise, call git_diff(name="${repo}", from="${since}", stat_only=true) for a file-level summary,\n` +
            `   then git_log(name="${repo}", limit=30) to enumerate commits.\n` +
            `3. Group commits by theme. Highlight breaking changes.`,
        },
      }],
    }),
  );

  // ─ debug-symbol ────────────────────────────────────────────
  server.registerPrompt(
    'debug-symbol',
    {
      title: 'Debug a symbol',
      description: 'Combined definition + callers + recent history walkthrough.',
      argsSchema: {
        repo: z.string().describe('Repo name'),
        symbol: z.string().describe('Symbol identifier'),
      },
    },
    ({ repo, symbol }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text:
            `Help me debug \`${symbol}\` in "${repo}".\n` +
            `1. find_symbol to locate the definition; read_file with function_at_line on the match.\n` +
            `2. find_references to enumerate callers; for any caller that looks suspicious, read its surrounding block.\n` +
            `3. git_log on the defining file, limit=10, so I see recent changes that could explain the bug.\n` +
            `Synthesize: what does ${symbol} do, who calls it, and what's the riskiest recent change?`,
        },
      }],
    }),
  );
}
