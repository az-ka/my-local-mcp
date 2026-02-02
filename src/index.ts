import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { addRepo, listRepos, syncRepo } from './tools/git.js';
import { listFiles, readFile, searchCode } from './tools/files.js';

// Create the MCP Server
const server = new McpServer({
  name: 'Local Docs MCP',
  version: '1.0.0',
});

// --- Git Tools ---

server.registerTool(
  'add_repo',
  {
    description: 'Clone a remote git repository to local storage.',
    inputSchema: {
      url: z.string().describe('The public GitHub URL of the repository'),
      name: z.string().optional().describe('Custom name/alias for the local folder'),
    },
  },
  async ({ url, name }) => {
    try {
      const result = await addRepo(url, name);
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

// --- File Reader Tools ---

server.registerTool(
  'list_files',
  {
    description: 'List files in a specific repository or subdirectory.',
    inputSchema: {
      repo: z.string().describe('The name of the repository (from list_repos)'),
      path: z.string().optional().default('').describe('Subdirectory path to list (optional)'),
    },
  },
  async ({ repo, path }) => {
    try {
      const files = await listFiles(repo, path);
      return { 
        content: [{ 
          type: 'text', 
          text: files.length > 0 ? files.join('\n') : 'No files found.' 
        }] 
      };
    } catch (error: any) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  }
);

server.registerTool(
  'read_file',
  {
    description: 'Read the content of a specific file.',
    inputSchema: {
      repo: z.string().describe('The name of the repository'),
      path: z.string().describe('Relative path to the file inside the repo'),
    },
  },
  async ({ repo, path }) => {
    try {
      const content = await readFile(repo, path);
      return { content: [{ type: 'text', text: content }] };
    } catch (error: any) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  }
);

server.registerTool(
  'search_code',
  {
    description: 'Search for a text string inside a repository.',
    inputSchema: {
      repo: z.string().describe('The name of the repository'),
      query: z.string().describe('The text string to search for'),
    },
  },
  async ({ repo, query }) => {
    try {
      const result = await searchCode(repo, query);
      return { content: [{ type: 'text', text: result }] };
    } catch (error: any) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  }
);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Local MCP Server running on StdIO...');
}

main().catch((error) => {
  console.error('Fatal Server Error:', error);
  process.exit(1);
});