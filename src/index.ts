import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  addRepo, listRepos, syncRepo,
  removeRepo, gitLog, gitShow, gitDiff, listBranches, listTags,
} from './tools/git.js';
import {
  listFiles, readFile, searchCode, getTree, findDocs, batchRead,
  findFiles, findSymbol, searchAllRepos,
} from './tools/files.js';

const server = new McpServer({
  name: 'Local Docs MCP',
  version: '3.0.0',
});

// ─── Git: repo management ────────────────────────────────────

server.registerTool(
  'add_repo',
  {
    description: 'Clone a remote git repository to local storage.',
    inputSchema: {
      url: z.string().describe('The public GitHub URL of the repository'),
      name: z.string().optional().describe('Custom name/alias for the local folder'),
      branch: z.string().optional().describe('Optional branch to clone. GitHub tree/<branch> URLs are also supported.'),
    },
  },
  async ({ url, name, branch }) => {
    try {
      const result = await addRepo(url, name, branch);
      return { content: [{ type: 'text', text: result }] };
    } catch (error: any) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  }
);

server.registerTool(
  'sync_repo',
  {
    description: 'Pull the latest changes for a specific repository or all repositories.',
    inputSchema: {
      name: z.string().optional().describe('The name of the repo to sync, or "all" for everything'),
    },
  },
  async ({ name }) => {
    try {
      const result = await syncRepo(name);
      return { content: [{ type: 'text', text: result }] };
    } catch (error: any) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  }
);

server.registerTool(
  'list_repos',
  { description: 'List all locally cloned repositories.' },
  async () => {
    try {
      const result = await listRepos();
      return { content: [{ type: 'text', text: result }] };
    } catch (error: any) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  }
);

server.registerTool(
  'remove_repo',
  {
    description: 'Remove a tracked repository. Deletes the local folder unless keep_files=true.',
    inputSchema: {
      name: z.string().describe('Name of the repo to remove'),
      keep_files: z.boolean().optional().default(false).describe('If true, only un-tracks; keeps files on disk.'),
    },
  },
  async ({ name, keep_files }) => {
    try {
      const result = await removeRepo(name, !keep_files);
      return { content: [{ type: 'text', text: result }] };
    } catch (error: any) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  }
);

// ─── Git: history & inspection ───────────────────────────────

server.registerTool(
  'git_log',
  {
    description:
      'View commit history for a repository. ' +
      'Use `file` to limit to one path, `since` for time-based filtering ("2 weeks ago", "2024-01-01").',
    inputSchema: {
      name: z.string().describe('Repository name'),
      limit: z.number().optional().default(20).describe('Max number of commits to show. Default: 20'),
      file: z.string().optional().describe('Limit log to commits touching this file path'),
      since: z.string().optional().describe('Time filter — e.g. "2 weeks ago", "2024-01-01"'),
    },
  },
  async ({ name, limit, file, since }) => {
    try {
      const result = await gitLog(name, { limit, file, since });
      return { content: [{ type: 'text', text: result }] };
    } catch (error: any) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  }
);

server.registerTool(
  'git_show',
  {
    description: 'Show the diff/details of a specific commit by SHA.',
    inputSchema: {
      name: z.string().describe('Repository name'),
      sha: z.string().describe('Commit SHA (4-40 hex chars)'),
    },
  },
  async ({ name, sha }) => {
    try {
      const result = await gitShow(name, sha);
      return { content: [{ type: 'text', text: result }] };
    } catch (error: any) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  }
);

server.registerTool(
  'git_diff',
  {
    description:
      'Diff between two refs (branches, tags, commits) or working tree. ' +
      'Use stat_only=true for a summary instead of full patch (recommended for big diffs).',
    inputSchema: {
      name: z.string().describe('Repository name'),
      from: z.string().optional().describe('Source ref (branch/tag/commit). e.g. "v1.0.0" or "main"'),
      to: z.string().optional().describe('Target ref. If omitted, diffs against working tree.'),
      file: z.string().optional().describe('Limit diff to a specific file path'),
      stat_only: z.boolean().optional().default(false).describe('Show only file stats (added/removed counts)'),
    },
  },
  async ({ name, from, to, file, stat_only }) => {
    try {
      const result = await gitDiff(name, { from, to, file, statOnly: stat_only });
      return { content: [{ type: 'text', text: result }] };
    } catch (error: any) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  }
);

server.registerTool(
  'list_branches',
  {
    description: 'List local (and optionally remote) branches in a repository.',
    inputSchema: {
      name: z.string().describe('Repository name'),
      include_remote: z.boolean().optional().default(false).describe('Also include remote branches (origin/*)'),
    },
  },
  async ({ name, include_remote }) => {
    try {
      const result = await listBranches(name, include_remote);
      return { content: [{ type: 'text', text: result }] };
    } catch (error: any) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  }
);

server.registerTool(
  'list_tags',
  {
    description: 'List tags (releases/versions) in a repository, sorted newest first.',
    inputSchema: {
      name: z.string().describe('Repository name'),
      limit: z.number().optional().default(50).describe('Max tags to show. Default: 50'),
    },
  },
  async ({ name, limit }) => {
    try {
      const result = await listTags(name, limit);
      return { content: [{ type: 'text', text: result }] };
    } catch (error: any) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  }
);

// ─── File reader tools ───────────────────────────────────────

server.registerTool(
  'list_files',
  {
    description:
      'List files in a specific repository or subdirectory. ' +
      'Supports filtering by file extension, showing file sizes, and limiting directory depth.',
    inputSchema: {
      repo: z.string().describe('The name of the repository (from list_repos)'),
      path: z.string().optional().default('').describe('Subdirectory path to list (optional)'),
      extensions: z.array(z.string()).optional().describe('Filter by extensions, e.g. [".md", ".ts"]'),
      include_size: z.boolean().optional().default(false).describe('Include file size in output'),
      max_depth: z.number().optional().describe('Maximum directory depth. 1 = current dir only.'),
    },
  },
  async ({ repo, path, extensions, include_size, max_depth }) => {
    try {
      const files = await listFiles(repo, path, {
        extensions, includeSize: include_size, maxDepth: max_depth,
      });
      return { content: [{ type: 'text', text: files.length > 0 ? files.join('\n') : 'No files found.' }] };
    } catch (error: any) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  }
);

server.registerTool(
  'read_file',
  {
    description:
      'Read the content of a specific file. ' +
      'Supports reading a line range. Negative start_line counts from end (e.g. -50 = last 50 lines).',
    inputSchema: {
      repo: z.string().describe('The name of the repository'),
      path: z.string().describe('Relative path to the file inside the repo'),
      start_line: z.number().optional().describe('Start line (1-indexed). Negative counts from end (e.g. -50 = last 50 lines).'),
      end_line: z.number().optional().describe('End line (inclusive). Omit to read to the end.'),
      max_size: z.number().optional().describe('Override max size in bytes for full reads. Default: 200KB.'),
    },
  },
  async ({ repo, path, start_line, end_line, max_size }) => {
    try {
      const content = await readFile(repo, path, {
        startLine: start_line, endLine: end_line, maxSize: max_size,
      });
      return { content: [{ type: 'text', text: content }] };
    } catch (error: any) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  }
);

server.registerTool(
  'search_code',
  {
    description:
      'Search for text/regex inside a repository. Skips binary files automatically. ' +
      'Supports case-sensitive, regex, whole-word, extension filter, context lines, max results, and path scoping.',
    inputSchema: {
      repo: z.string().describe('The name of the repository'),
      query: z.string().describe('Text or regex pattern to search for'),
      extensions: z.array(z.string()).optional().describe('Only search files with these extensions'),
      context_lines: z.number().optional().default(0).describe('Lines of context above/below each match'),
      max_results: z.number().optional().default(50).describe('Max matching lines. Default: 50'),
      path: z.string().optional().describe('Scope to a subdirectory'),
      case_sensitive: z.boolean().optional().default(false).describe('Case-sensitive match. Default: false'),
      regex: z.boolean().optional().default(false).describe('Treat query as regex. Default: false (literal string)'),
      whole_word: z.boolean().optional().default(false).describe('Match whole words only'),
    },
  },
  async ({ repo, query, extensions, context_lines, max_results, path, case_sensitive, regex, whole_word }) => {
    try {
      const result = await searchCode(repo, query, {
        extensions, contextLines: context_lines, maxResults: max_results, path,
        caseSensitive: case_sensitive, regex, wholeWord: whole_word,
      });
      return { content: [{ type: 'text', text: result }] };
    } catch (error: any) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  }
);

server.registerTool(
  'get_tree',
  {
    description:
      'Get a visual directory tree of a repository. ' +
      'Great for understanding structure before diving into specific files.',
    inputSchema: {
      repo: z.string().describe('Repository name'),
      path: z.string().optional().describe('Subdirectory to start from'),
      max_depth: z.number().optional().default(3).describe('Max depth. Default: 3'),
      show_files: z.boolean().optional().default(true).describe('Show files. False = directories only'),
      extensions: z.array(z.string()).optional().describe('Only show files with these extensions'),
    },
  },
  async ({ repo, path, max_depth, show_files, extensions }) => {
    try {
      const result = await getTree(repo, {
        path, maxDepth: max_depth, showFiles: show_files, extensions,
      });
      return { content: [{ type: 'text', text: result }] };
    } catch (error: any) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  }
);

server.registerTool(
  'find_docs',
  {
    description:
      'Smart documentation discovery. Finds README, docs/, and doc files (.md, .mdx, .rst) ' +
      'ranked by relevance. Use this FIRST when exploring an unfamiliar repository.',
    inputSchema: {
      repo: z.string().describe('Repository name'),
      topic: z.string().optional().describe('Optional topic to boost relevant docs'),
    },
  },
  async ({ repo, topic }) => {
    try {
      const result = await findDocs(repo, { topic });
      return { content: [{ type: 'text', text: result }] };
    } catch (error: any) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  }
);

server.registerTool(
  'batch_read',
  {
    description:
      'Read multiple files in a single call. Each file is capped at 10KB by default. ' +
      'Use to efficiently read several related files at once.',
    inputSchema: {
      repo: z.string().describe('Repository name'),
      paths: z.array(z.string()).describe('Array of relative file paths to read'),
      max_size_per_file: z.number().optional().default(10240).describe('Max bytes per file. Default: 10KB'),
    },
  },
  async ({ repo, paths, max_size_per_file }) => {
    try {
      const result = await batchRead(repo, paths, { maxSizePerFile: max_size_per_file });
      return { content: [{ type: 'text', text: result }] };
    } catch (error: any) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  }
);

// ─── New file/symbol tools ───────────────────────────────────

server.registerTool(
  'find_files',
  {
    description:
      'Find files by glob pattern. Faster than list_files+grep when you know roughly what file you want. ' +
      'Examples: "**/*Config*.ts", "src/**/*.py", "**/test_*.py"',
    inputSchema: {
      repo: z.string().describe('Repository name'),
      pattern: z.string().describe('Glob pattern, e.g. "**/*Config*.ts"'),
      path: z.string().optional().describe('Subdirectory to search in'),
      max_results: z.number().optional().default(200).describe('Max files to return'),
    },
  },
  async ({ repo, pattern, path, max_results }) => {
    try {
      const result = await findFiles(repo, pattern, { path, maxResults: max_results });
      return { content: [{ type: 'text', text: result }] };
    } catch (error: any) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  }
);

server.registerTool(
  'find_symbol',
  {
    description:
      'Find function/class/interface/type DEFINITIONS by name across the repo. ' +
      'Supports TS/JS, Python, Go, Rust, Java/Kotlin/C#, PHP, Ruby. ' +
      'Use this when AI asks "where is X defined?" — far more precise than search_code.',
    inputSchema: {
      repo: z.string().describe('Repository name'),
      name: z.string().describe('Symbol name (must be a valid identifier)'),
      kind: z.enum(['function', 'class', 'method', 'interface', 'type', 'const', 'any']).optional()
        .describe('Filter by kind. Default: any'),
      extensions: z.array(z.string()).optional().describe('Limit to specific languages by extension'),
      path: z.string().optional().describe('Scope to a subdirectory'),
      max_results: z.number().optional().default(50).describe('Max matches. Default: 50'),
    },
  },
  async ({ repo, name, kind, extensions, path, max_results }) => {
    try {
      const result = await findSymbol(repo, name, { kind, extensions, path, maxResults: max_results });
      return { content: [{ type: 'text', text: result }] };
    } catch (error: any) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  }
);

server.registerTool(
  'search_all_repos',
  {
    description:
      'Search across ALL tracked repositories at once. ' +
      'Use sparingly — slower than search_code on a single repo. Great for "which library has X?".',
    inputSchema: {
      query: z.string().describe('Text or regex to search for'),
      extensions: z.array(z.string()).optional().describe('Only search files with these extensions'),
      max_results_per_repo: z.number().optional().default(10).describe('Max matches per repo. Default: 10'),
      case_sensitive: z.boolean().optional().default(false).describe('Case-sensitive match'),
      regex: z.boolean().optional().default(false).describe('Treat query as regex'),
      whole_word: z.boolean().optional().default(false).describe('Match whole words only'),
    },
  },
  async ({ query, extensions, max_results_per_repo, case_sensitive, regex, whole_word }) => {
    try {
      const result = await searchAllRepos(query, {
        extensions, maxResultsPerRepo: max_results_per_repo,
        caseSensitive: case_sensitive, regex, wholeWord: whole_word,
      });
      return { content: [{ type: 'text', text: result }] };
    } catch (error: any) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  }
);

// ─── Start ───────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Local MCP Server v3.0 running on StdIO — 18 tools loaded');
}

main().catch((error) => {
  console.error('Fatal Server Error:', error);
  process.exit(1);
});
