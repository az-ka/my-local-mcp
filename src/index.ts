import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { addRepo, listRepos, syncRepo } from './tools/git.js';
import { listFiles, readFile, searchCode, getTree, findDocs, batchRead } from './tools/files.js';

// Create the MCP Server
const server = new McpServer({
  name: 'Local Docs MCP',
  version: '2.0.0',
});

// ─── Git Tools ───────────────────────────────────────────────

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
  {
    description: 'List all locally cloned repositories.',
  },
  async () => {
    try {
      const result = await listRepos();
      return { content: [{ type: 'text', text: result }] };
    } catch (error: any) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  }
);

// ─── File Reader Tools ───────────────────────────────────────

server.registerTool(
  'list_files',
  {
    description:
      'List files in a specific repository or subdirectory. ' +
      'Supports filtering by file extension, showing file sizes, and limiting directory depth.',
    inputSchema: {
      repo: z.string().describe('The name of the repository (from list_repos)'),
      path: z.string().optional().default('').describe('Subdirectory path to list (optional)'),
      extensions: z
        .array(z.string())
        .optional()
        .describe('Filter by file extensions, e.g. [".md", ".ts"]. Returns only files matching these extensions.'),
      include_size: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include file size in output (e.g. "docs/intro.md (2.1KB)")'),
      max_depth: z
        .number()
        .optional()
        .describe('Maximum directory depth to traverse. 1 = current dir only, 2 = one level of subdirs, etc.'),
    },
  },
  async ({ repo, path, extensions, include_size, max_depth }) => {
    try {
      const files = await listFiles(repo, path, {
        extensions,
        includeSize: include_size,
        maxDepth: max_depth,
      });
      return {
        content: [
          {
            type: 'text',
            text: files.length > 0 ? files.join('\n') : 'No files found.',
          },
        ],
      };
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
      'Supports reading a specific line range to avoid loading entire large files.',
    inputSchema: {
      repo: z.string().describe('The name of the repository'),
      path: z.string().describe('Relative path to the file inside the repo'),
      start_line: z
        .number()
        .optional()
        .describe('Start reading from this line number (1-indexed). Omit to read from the beginning.'),
      end_line: z
        .number()
        .optional()
        .describe('Stop reading at this line number (inclusive). Omit to read to the end.'),
    },
  },
  async ({ repo, path, start_line, end_line }) => {
    try {
      const content = await readFile(repo, path, {
        startLine: start_line,
        endLine: end_line,
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
      'Search for a text string inside a repository. ' +
      'Supports filtering by file extension, showing context lines around matches, ' +
      'limiting results, and scoping to a subdirectory.',
    inputSchema: {
      repo: z.string().describe('The name of the repository'),
      query: z.string().describe('The text string to search for (case-insensitive)'),
      extensions: z
        .array(z.string())
        .optional()
        .describe('Only search in files with these extensions, e.g. [".md", ".ts"]'),
      context_lines: z
        .number()
        .optional()
        .default(0)
        .describe('Number of lines to show above and below each match for context. Default: 0'),
      max_results: z
        .number()
        .optional()
        .default(50)
        .describe('Maximum number of matching lines to return. Default: 50'),
      path: z
        .string()
        .optional()
        .describe('Scope search to a specific subdirectory, e.g. "docs" or "src/utils"'),
    },
  },
  async ({ repo, query, extensions, context_lines, max_results, path }) => {
    try {
      const result = await searchCode(repo, query, {
        extensions,
        contextLines: context_lines,
        maxResults: max_results,
        path,
      });
      return { content: [{ type: 'text', text: result }] };
    } catch (error: any) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  }
);

// ─── New Tools ───────────────────────────────────────────────

server.registerTool(
  'get_tree',
  {
    description:
      'Get a visual directory tree of a repository. ' +
      'Great for understanding repo structure before diving into specific files. ' +
      'Shows directories and files in a tree format with configurable depth.',
    inputSchema: {
      repo: z.string().describe('The name of the repository'),
      path: z
        .string()
        .optional()
        .describe('Subdirectory to start from. Omit for repo root.'),
      max_depth: z
        .number()
        .optional()
        .default(3)
        .describe('Maximum depth of the tree. Default: 3. Use 1-2 for large repos.'),
      show_files: z
        .boolean()
        .optional()
        .default(true)
        .describe('Show files in the tree. Set false to see only directories.'),
      extensions: z
        .array(z.string())
        .optional()
        .describe('Only show files with these extensions in the tree, e.g. [".md", ".ts"]'),
    },
  },
  async ({ repo, path, max_depth, show_files, extensions }) => {
    try {
      const result = await getTree(repo, {
        path,
        maxDepth: max_depth,
        showFiles: show_files,
        extensions,
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
      'Smart documentation discovery. Finds README, docs/, and documentation files (.md, .mdx, .rst, .txt) ' +
      'in a repository, ranked by relevance. Shows preview snippets for top results. ' +
      'Use this FIRST when exploring an unfamiliar repository.',
    inputSchema: {
      repo: z.string().describe('The name of the repository'),
      topic: z
        .string()
        .optional()
        .describe('Optional topic to filter/boost relevant docs, e.g. "authentication", "routing", "api"'),
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
      'Read multiple files in a single call. ' +
      'Each file is capped at 10KB by default to prevent context overflow. ' +
      'Use this to efficiently read several related files at once instead of calling read_file multiple times.',
    inputSchema: {
      repo: z.string().describe('The name of the repository'),
      paths: z
        .array(z.string())
        .describe('Array of relative file paths to read, e.g. ["README.md", "docs/intro.md", "src/index.ts"]'),
      max_size_per_file: z
        .number()
        .optional()
        .default(10240)
        .describe('Maximum bytes to read per file. Default: 10240 (10KB). Increase for larger files.'),
    },
  },
  async ({ repo, paths, max_size_per_file }) => {
    try {
      const result = await batchRead(repo, paths, {
        maxSizePerFile: max_size_per_file,
      });
      return { content: [{ type: 'text', text: result }] };
    } catch (error: any) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  }
);

// ─── Start Server ────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Local MCP Server v2.0 running on StdIO...');
}

main().catch((error) => {
  console.error('Fatal Server Error:', error);
  process.exit(1);
});
