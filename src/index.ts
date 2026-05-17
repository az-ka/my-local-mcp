import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  addRepo, addLocalFolder, listRepos, syncRepo, removeRepo,
  gitLog, gitShow, gitDiff, listBranches, listTags,
  gitBlame, gitStatus, gitGrep,
} from './tools/git';
import {
  listFiles, listFilesPaged, readFile, searchCode, getTree, findDocs, batchRead,
  findFiles, findSymbol, findReferences, searchAllRepos,
  invalidateRepoCaches,
} from './tools/files';
import { formatErrorText, debug, isDebugEnabled } from './shared';
import { registerResources } from './resources';
import { registerPrompts } from './prompts';

const SERVER_VERSION = '4.0.0';
const TOOL_COUNT = 24;

const server = new McpServer({
  name: 'Local Docs MCP',
  version: SERVER_VERSION,
});

/**
 * Wraps an async tool handler so any thrown error becomes a structured
 * `[CODE] message` text response with `isError: true`. Keeps the SDK
 * contract intact (`content` array of typed entries) while giving the AI
 * a parseable error code.
 */
function tool<R>(
  name: string,
  fn: () => Promise<R>,
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  const t0 = isDebugEnabled() ? performance.now() : 0;
  return fn().then(
    (result) => {
      if (isDebugEnabled()) debug(`tool ${name} ok (${(performance.now() - t0).toFixed(1)}ms)`);
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      return { content: [{ type: 'text' as const, text }] };
    },
    (error: unknown) => {
      if (isDebugEnabled()) debug(`tool ${name} fail (${(performance.now() - t0).toFixed(1)}ms)`, error);
      return { content: [{ type: 'text' as const, text: formatErrorText(error) }], isError: true };
    },
  );
}

// ═══════════════════════════════════════════════════════════
// Repo management
// ═══════════════════════════════════════════════════════════

server.registerTool(
  'add_repo',
  {
    description:
      'Clone a remote git repository into local storage.\n\n' +
      'Use when: the user mentions a GitHub URL or asks to "add/install/clone" a repo.\n' +
      'Accepts: bare URL, `owner/repo`, `tree/<branch>`, `commit/<sha>`, `releases/tag/<tag>`.\n' +
      'Auth: set MCP_GITHUB_TOKEN env for private repos (token is injected at clone time, never stored).\n' +
      'NOT for: registering a folder already on disk — use add_local_folder for that.',
    inputSchema: {
      url: z.string().describe('The public GitHub URL or "owner/repo"'),
      name: z.string().optional().describe('Custom name/alias. Default: inferred from URL.'),
      branch: z.string().optional().describe('Branch to clone. Wins over branch implied by tree/ URL.'),
      depth: z.number().optional().describe('Shallow clone depth. 0 = full history (default).'),
    },
  },
  async ({ url, name, branch, depth }) => tool('add_repo',
    () => addRepo(url, name, branch, { depth }),
  ),
);

server.registerTool(
  'add_local_folder',
  {
    description:
      'Register an existing local folder as a tracked entry without cloning.\n\n' +
      'Use when: the user has a project already on disk they want the server to read.\n' +
      'If the folder contains a `.git/`, the entry is still git-enabled.\n' +
      'NOT for: cloning from URLs — use add_repo for that.',
    inputSchema: {
      path: z.string().describe('Absolute or cwd-relative path to the folder'),
      name: z.string().optional().describe('Custom alias. Default: folder basename.'),
    },
  },
  async ({ path, name }) => tool('add_local_folder', () => addLocalFolder(path, name)),
);

server.registerTool(
  'sync_repo',
  {
    description:
      'Pull latest changes for one repo or all of them.\n\n' +
      'Use when: the user says "update", "pull", "refresh", or implies stale data.\n' +
      'Pass name="all" or omit `name` to sync everything. Local-folder entries are skipped.',
    inputSchema: {
      name: z.string().optional().describe('Repo name, or "all" (default) for every tracked repo'),
    },
  },
  async ({ name }) => tool('sync_repo', async () => {
    const out = await syncRepo(name);
    if (name && name !== 'all') invalidateRepoCaches(name);
    return out;
  }),
);

server.registerTool(
  'list_repos',
  {
    description:
      'List tracked repositories with branch + last-sync metadata.\n\n' +
      'Use when: the user asks "which repos do I have?" or before any tool that takes a `repo` arg.\n' +
      'Supports filter substring and sort by name|lastSync|branch.',
    inputSchema: {
      filter: z.string().optional().describe('Substring filter (case-insensitive)'),
      sort: z.enum(['name', 'lastSync', 'branch']).optional().describe('Sort key (default: name)'),
    },
  },
  async ({ filter, sort }) => tool('list_repos', () => listRepos({ filter, sort })),
);

server.registerTool(
  'remove_repo',
  {
    description:
      'Un-track a repo. By default deletes the cloned folder; for local-folder entries the on-disk folder is always left in place.\n\n' +
      'Use when: the user says "remove", "delete", "drop" a repo.\n' +
      'Pass keep_files=true to keep the storage clone on disk.',
    inputSchema: {
      name: z.string().describe('Repo name'),
      keep_files: z.boolean().optional().default(false).describe('Keep files on disk (only relevant for git clones)'),
    },
  },
  async ({ name, keep_files }) => tool('remove_repo', async () => {
    invalidateRepoCaches(name);
    return removeRepo(name, !keep_files);
  }),
);

// ═══════════════════════════════════════════════════════════
// Git inspection
// ═══════════════════════════════════════════════════════════

server.registerTool(
  'git_log',
  {
    description:
      'View commit history.\n\n' +
      'Use when: "what changed recently?", "history of <file>", "commits since <date>".\n' +
      '`file` narrows to commits that touched that path.\n' +
      '`since` accepts a git-style date phrase ("2 weeks ago", "2024-01-01").',
    inputSchema: {
      name: z.string().describe('Repository name'),
      limit: z.number().optional().default(20).describe('Max commits. Default: 20'),
      file: z.string().optional().describe('Limit to commits touching this file'),
      since: z.string().optional().describe('Time filter — e.g. "2 weeks ago"'),
    },
  },
  async ({ name, limit, file, since }) => tool('git_log',
    () => gitLog(name, { limit, file, since }),
  ),
);

server.registerTool(
  'git_show',
  {
    description:
      'Show the full diff + stat for one commit.\n\n' +
      'Use when: the user references a specific SHA or asks "what did <commit> do?".\n' +
      'Accepts hex 4-40 chars only.',
    inputSchema: {
      name: z.string().describe('Repository name'),
      sha: z.string().describe('Commit SHA (4-40 hex chars)'),
    },
  },
  async ({ name, sha }) => tool('git_show', () => gitShow(name, sha)),
);

server.registerTool(
  'git_diff',
  {
    description:
      'Diff between two refs (branches, tags, commits) or against working tree.\n\n' +
      'Use when: "compare v1 vs v2", "what changed in branch X vs main", "show me the diff for <file>".\n' +
      'Use stat_only=true for large diffs to avoid blowing the response window.',
    inputSchema: {
      name: z.string().describe('Repository name'),
      from: z.string().optional().describe('Source ref'),
      to: z.string().optional().describe('Target ref. Omit to diff against working tree.'),
      file: z.string().optional().describe('Limit diff to a path'),
      stat_only: z.boolean().optional().default(false).describe('Summary only (recommended for big diffs)'),
    },
  },
  async ({ name, from, to, file, stat_only }) => tool('git_diff',
    () => gitDiff(name, { from, to, file, statOnly: stat_only }),
  ),
);

server.registerTool(
  'list_branches',
  {
    description:
      'List branches in a repo.\n\n' +
      'Use when: "what branches are there?", before passing a branch name to other tools.',
    inputSchema: {
      name: z.string().describe('Repository name'),
      include_remote: z.boolean().optional().default(false).describe('Also include origin/*'),
    },
  },
  async ({ name, include_remote }) => tool('list_branches',
    () => listBranches(name, include_remote),
  ),
);

server.registerTool(
  'list_tags',
  {
    description:
      'List tags (releases) in a repo, sorted newest-first by string order.\n\n' +
      'Use when: the user asks about versions/releases, or before a tag-based git_diff.',
    inputSchema: {
      name: z.string().describe('Repository name'),
      limit: z.number().optional().default(50).describe('Max tags. Default: 50'),
    },
  },
  async ({ name, limit }) => tool('list_tags', () => listTags(name, limit)),
);

server.registerTool(
  'git_blame',
  {
    description:
      'Show which commit/author last touched each line of a file.\n\n' +
      'Use when: "who wrote this?", "when did this line change?", debugging a regression.\n' +
      'Pair with start_line/end_line to keep the response small.',
    inputSchema: {
      name: z.string().describe('Repository name'),
      file: z.string().describe('Path inside the repo'),
      start_line: z.number().optional().describe('1-indexed start line'),
      end_line: z.number().optional().describe('1-indexed inclusive end line'),
    },
  },
  async ({ name, file, start_line, end_line }) => tool('git_blame',
    () => gitBlame(name, file, { startLine: start_line, endLine: end_line }),
  ),
);

server.registerTool(
  'git_status',
  {
    description:
      'Show working-tree status (staged/modified/untracked).\n\n' +
      'Use when: the user has a local-folder entry and wants to know its current state.\n' +
      'For cloned repos this is almost always clean.',
    inputSchema: {
      name: z.string().describe('Repository name'),
    },
  },
  async ({ name }) => tool('git_status', () => gitStatus(name)),
);

server.registerTool(
  'git_grep',
  {
    description:
      'Fast text search using `git grep`. Honors .gitignore. Typically 5-10× faster than search_code on large repos.\n\n' +
      'Use when: the repo is big OR you want to match the user\'s `.gitignore` semantics exactly.\n' +
      'Prefer search_code when: you need regex/whole-word/context-lines fully customisable, or the entry is a non-git local folder.',
    inputSchema: {
      name: z.string().describe('Repository name'),
      query: z.string().describe('Text to search for (fixed string by default)'),
      ignore_case: z.boolean().optional().default(false).describe('Case-insensitive'),
      regex: z.boolean().optional().default(false).describe('Treat query as POSIX regex'),
      path: z.string().optional().describe('Restrict to a path'),
      max_results: z.number().optional().default(100).describe('Max matches. Default: 100'),
    },
  },
  async ({ name, query, ignore_case, regex, path, max_results }) => tool('git_grep',
    () => gitGrep(name, query, {
      ignoreCase: ignore_case,
      fixedStrings: !regex,
      path,
      maxResults: max_results,
    }),
  ),
);

// ═══════════════════════════════════════════════════════════
// File & code exploration
// ═══════════════════════════════════════════════════════════

server.registerTool(
  'list_files',
  {
    description:
      'List files in a repo or subdirectory, with optional pagination.\n\n' +
      'Use when: you need a flat file inventory. For visual hierarchy use get_tree instead.\n' +
      'Supports extensions filter, size annotations, max_depth, and pagination via offset/limit.',
    inputSchema: {
      repo: z.string().describe('Repository name'),
      path: z.string().optional().default('').describe('Subdirectory (optional)'),
      extensions: z.array(z.string()).optional().describe('Filter by extensions, e.g. [".md", ".ts"]'),
      include_size: z.boolean().optional().default(false).describe('Annotate files with size'),
      max_depth: z.number().optional().describe('Max directory depth (1 = current dir only)'),
      offset: z.number().optional().describe('Skip N entries (for pagination)'),
      limit: z.number().optional().describe('Max entries to return'),
    },
  },
  async ({ repo, path, extensions, include_size, max_depth, offset, limit }) => tool('list_files', async () => {
    const r = await listFilesPaged(repo, path, {
      extensions, includeSize: include_size, maxDepth: max_depth, offset, limit,
    });
    if (r.items.length === 0) return 'No files found.';
    const header = `Showing ${r.items.length} of ${r.total}${r.offset ? ` (skip ${r.offset})` : ''}`;
    const footer = r.hasMore ? `\n[hasMore=true. Use offset=${r.offset + r.items.length} for next page.]` : '';
    return `${header}\n${r.items.join('\n')}${footer}`;
  }),
);

server.registerTool(
  'read_file',
  {
    description:
      'Read a file with flexible scoping.\n\n' +
      'Modes (first present wins):\n' +
      '  1. function_at_line=N      — extract the enclosing function/class/block.\n' +
      '  2. around_line=N           — window centred on N (context_lines each side, default 25).\n' +
      '  3. start_line/end_line     — explicit 1-indexed range; negative start = tail (-50 = last 50).\n' +
      '  4. (none)                  — whole file, truncated to max_size (default 200KB).\n\n' +
      'Use when: any file read. Prefer function_at_line / around_line after a search hit to keep response compact.',
    inputSchema: {
      repo: z.string().describe('Repository name'),
      path: z.string().describe('Relative path inside the repo'),
      start_line: z.number().optional().describe('1-indexed start. Negative counts from end.'),
      end_line: z.number().optional().describe('1-indexed inclusive end. Omit to read to EOF.'),
      max_size: z.number().optional().describe('Override max bytes for full-file reads'),
      around_line: z.number().optional().describe('Read a window centered on this line'),
      context_lines: z.number().optional().describe('Window radius (each side). Default 25.'),
      function_at_line: z.number().optional().describe('Return the enclosing block of this line'),
    },
  },
  async ({ repo, path, start_line, end_line, max_size, around_line, context_lines, function_at_line }) => tool('read_file',
    () => readFile(repo, path, {
      startLine: start_line, endLine: end_line, maxSize: max_size,
      aroundLine: around_line, contextLines: context_lines, functionAtLine: function_at_line,
    }),
  ),
);

server.registerTool(
  'search_code',
  {
    description:
      'Search file contents for text/regex. Skips binaries.\n\n' +
      'Use when: text matching matters (strings, error messages, comments).\n' +
      'Prefer git_grep for large repos when .gitignore semantics are wanted.\n' +
      'Prefer find_symbol when looking for a definition by identifier name.\n' +
      'Supports group=true to bucket matches by file, and format="json" for machine-parseable output.',
    inputSchema: {
      repo: z.string().describe('Repository name'),
      query: z.string().describe('Text or regex pattern'),
      extensions: z.array(z.string()).optional().describe('Only search files with these extensions'),
      context_lines: z.number().optional().default(0).describe('Lines of context above/below each match'),
      max_results: z.number().optional().default(50).describe('Max matches. Default: 50'),
      path: z.string().optional().describe('Scope to a subdirectory'),
      case_sensitive: z.boolean().optional().default(false).describe('Case-sensitive match'),
      regex: z.boolean().optional().default(false).describe('Treat query as regex'),
      whole_word: z.boolean().optional().default(false).describe('Match whole words only'),
      group: z.boolean().optional().default(false).describe('Bucket results by file'),
      format: z.enum(['text', 'json']).optional().describe('Output format. Default: text.'),
    },
  },
  async ({ repo, query, extensions, context_lines, max_results, path, case_sensitive, regex, whole_word, group, format }) => tool('search_code',
    () => searchCode(repo, query, {
      extensions, contextLines: context_lines, maxResults: max_results, path,
      caseSensitive: case_sensitive, regex, wholeWord: whole_word,
      group, format,
    }),
  ),
);

server.registerTool(
  'get_tree',
  {
    description:
      'Render a visual ASCII directory tree.\n\n' +
      'Use when: you want hierarchy at a glance before drilling in. Cap with max_depth (default 3) for big repos.',
    inputSchema: {
      repo: z.string().describe('Repository name'),
      path: z.string().optional().describe('Subdirectory'),
      max_depth: z.number().optional().default(3).describe('Max depth. Default 3'),
      show_files: z.boolean().optional().default(true).describe('Show files (false = dirs only)'),
      extensions: z.array(z.string()).optional().describe('Only show files with these extensions'),
    },
  },
  async ({ repo, path, max_depth, show_files, extensions }) => tool('get_tree',
    () => getTree(repo, { path, maxDepth: max_depth, showFiles: show_files, extensions }),
  ),
);

server.registerTool(
  'find_docs',
  {
    description:
      'Smart documentation discovery: README, docs/, CHANGELOG, etc. Ranked by relevance.\n\n' +
      'Use when: you start exploring an unfamiliar repo. Use FIRST before deep code dives.\n' +
      'Pass `topic` to boost related docs (e.g. topic="auth" prefers auth-related files).',
    inputSchema: {
      repo: z.string().describe('Repository name'),
      topic: z.string().optional().describe('Optional topic to bias ranking'),
    },
  },
  async ({ repo, topic }) => tool('find_docs', () => findDocs(repo, { topic })),
);

server.registerTool(
  'batch_read',
  {
    description:
      'Read multiple files in one call (each capped to keep response bounded).\n\n' +
      'Use when: you need to compare/synthesize a few related files. Defaults to 10KB per file.',
    inputSchema: {
      repo: z.string().describe('Repository name'),
      paths: z.array(z.string()).describe('Array of relative file paths'),
      max_size_per_file: z.number().optional().default(10240).describe('Max bytes per file. Default 10KB'),
    },
  },
  async ({ repo, paths, max_size_per_file }) => tool('batch_read',
    () => batchRead(repo, paths, { maxSizePerFile: max_size_per_file }),
  ),
);

server.registerTool(
  'find_files',
  {
    description:
      'Find files by glob pattern. Honors .mcpignore + default ignores.\n\n' +
      'Use when: you know roughly the filename shape but not the location.\n' +
      'Examples: "**/*Config*.ts", "src/**/*.py", "**/test_*.py".\n' +
      'Prefer over list_files+grep when the goal is a filename match.',
    inputSchema: {
      repo: z.string().describe('Repository name'),
      pattern: z.string().describe('Glob pattern'),
      path: z.string().optional().describe('Subdirectory to start from'),
      max_results: z.number().optional().default(200).describe('Max files. Default: 200'),
      offset: z.number().optional().describe('Skip N entries (pagination)'),
    },
  },
  async ({ repo, pattern, path, max_results, offset }) => tool('find_files',
    () => findFiles(repo, pattern, { path, maxResults: max_results, offset }),
  ),
);

server.registerTool(
  'find_symbol',
  {
    description:
      'Find DEFINITIONS by identifier name across the repo.\n\n' +
      'Supports: TS/JS, Python, Go, Rust, Java/Kotlin/C#, PHP, Ruby, Swift.\n' +
      'Kinds: function | method | class | interface | trait | type | enum | struct | impl | const.\n\n' +
      'Use when: "where is X defined?". Far more precise than search_code with a name.\n' +
      'Does NOT find callers/references — use find_references for that.\n' +
      'Reports enclosing scope (e.g. "AuthService") when detectable.',
    inputSchema: {
      repo: z.string().describe('Repository name'),
      name: z.string().describe('Identifier (must match [A-Za-z_$][A-Za-z0-9_$]*)'),
      kind: z.enum(['function', 'method', 'class', 'interface', 'trait', 'type', 'enum', 'struct', 'impl', 'const', 'any']).optional().describe('Filter by kind'),
      extensions: z.array(z.string()).optional().describe('Limit to specific languages by extension'),
      path: z.string().optional().describe('Scope to a subdirectory'),
      max_results: z.number().optional().default(50).describe('Max matches. Default: 50'),
      offset: z.number().optional().describe('Skip N matches (pagination)'),
      format: z.enum(['text', 'json']).optional().describe('Output format. Default: text.'),
    },
  },
  async ({ repo, name, kind, extensions, path, max_results, offset, format }) => tool('find_symbol',
    () => findSymbol(repo, name, { kind, extensions, path, maxResults: max_results, offset, format }),
  ),
);

server.registerTool(
  'find_references',
  {
    description:
      'Find every reference (caller/usage) of an identifier across the repo.\n\n' +
      'Use when: you already know where X is defined and want to know who uses it.\n' +
      'Pair with exclude_comments_and_strings=true to skip false positives inside string literals and comments.\n' +
      'Pair with exclude_definitions=true to keep only callers.\n' +
      'Returns lines with file:line and a [def] marker for definition lines (unless excluded).',
    inputSchema: {
      repo: z.string().describe('Repository name'),
      name: z.string().describe('Identifier'),
      extensions: z.array(z.string()).optional().describe('Limit to specific languages by extension'),
      path: z.string().optional().describe('Scope to a subdirectory'),
      max_results: z.number().optional().default(100).describe('Max matches. Default: 100'),
      offset: z.number().optional().describe('Skip N matches (pagination)'),
      exclude_definitions: z.boolean().optional().default(false).describe('Skip definition lines (callers only)'),
      exclude_comments_and_strings: z.boolean().optional().default(false).describe('Heuristic strip of comments/strings to reduce false positives'),
      format: z.enum(['text', 'json']).optional().describe('Output format. Default: text.'),
    },
  },
  async ({ repo, name, extensions, path, max_results, offset, exclude_definitions, exclude_comments_and_strings, format }) => tool('find_references',
    () => findReferences(repo, name, {
      extensions, path, maxResults: max_results, offset,
      excludeDefinitions: exclude_definitions,
      excludeCommentsAndStrings: exclude_comments_and_strings,
      format,
    }),
  ),
);

server.registerTool(
  'search_all_repos',
  {
    description:
      'Run a search across every tracked repo at once.\n\n' +
      'Use when: "which library has X?" — exploratory cross-repo queries.\n' +
      'AVOID for narrow queries: slower than searching one repo, and noisier output.',
    inputSchema: {
      query: z.string().describe('Text or regex to search for'),
      extensions: z.array(z.string()).optional().describe('Filter by extensions'),
      max_results_per_repo: z.number().optional().default(10).describe('Max matches per repo. Default: 10'),
      case_sensitive: z.boolean().optional().default(false).describe('Case-sensitive match'),
      regex: z.boolean().optional().default(false).describe('Treat query as regex'),
      whole_word: z.boolean().optional().default(false).describe('Match whole words only'),
    },
  },
  async ({ query, extensions, max_results_per_repo, case_sensitive, regex, whole_word }) => tool('search_all_repos',
    () => searchAllRepos(query, {
      extensions, maxResultsPerRepo: max_results_per_repo,
      caseSensitive: case_sensitive, regex, wholeWord: whole_word,
    }),
  ),
);

// ═══════════════════════════════════════════════════════════
// Resources + Prompts
// ═══════════════════════════════════════════════════════════

registerResources(server);
registerPrompts(server);

// ═══════════════════════════════════════════════════════════
// Start
// ═══════════════════════════════════════════════════════════

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `Local MCP Server v${SERVER_VERSION} running on StdIO — ${TOOL_COUNT} tools + resources + prompts loaded` +
    (isDebugEnabled() ? ' [debug]' : ''),
  );
}

main().catch((error) => {
  console.error('Fatal Server Error:', error);
  process.exit(1);
});
