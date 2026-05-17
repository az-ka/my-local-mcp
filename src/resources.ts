/**
 * MCP Resources registration.
 *
 * Why: Resources let users @-mention specific files in clients (Claude Desktop,
 * Cursor) without spending tool-call tokens. Each tracked repo is exposed
 * through TWO URI shapes:
 *
 *   1. `localrepo://<repo>`         — repo metadata blob (one resource)
 *   2. `localrepo://<repo>/<path>`  — any file inside the repo (template)
 *
 * The template path is matched by `listResources` so clients can autocomplete.
 *
 * Notes:
 *   - We list at most `MAX_FILES_PER_REPO` per repo to keep responses bounded.
 *   - Binary files appear in the listing but their `read` returns a stub.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import fs from 'fs-extra';
import path from 'path';
import glob from 'fast-glob';
import { getConfig } from './config';
import {
  resolveRepoPath,
  repoRootPath,
  loadIgnorePatterns,
  isBinaryExtension,
  looksBinary,
  formatSize,
} from './shared';

const MAX_FILES_PER_REPO = 500;
const MAX_RESOURCE_BYTES = 200 * 1024;

export function registerResources(server: McpServer): void {
  // ─ Per-repo metadata blob ──────────────────────────────────
  server.registerResource(
    'repo-overview',
    new ResourceTemplate('localrepo://{repo}', {
      list: async () => {
        const config = await getConfig();
        const resources = Object.entries(config.repos).map(([name, info]) => ({
          uri: `localrepo://${name}`,
          name: `${name} — overview`,
          mimeType: 'application/json',
          description: `${info.url || '(local)'} [branch: ${info.branch || 'unknown'}]`,
        }));
        return { resources };
      },
    }),
    {
      title: 'Repo overview',
      description: 'JSON metadata describing one tracked repository.',
      mimeType: 'application/json',
    },
    async (uri, vars) => {
      const repoName = String(vars.repo);
      const config = await getConfig();
      const info = config.repos[repoName];
      if (!info) {
        throw new Error(`Repository "${repoName}" not found.`);
      }
      const repoRoot = repoRootPath(config.storagePath, repoName, info.localPath);
      let exists = false;
      try { exists = await fs.pathExists(repoRoot); } catch { /* ignore */ }
      const payload = {
        name: repoName,
        url: info.url || null,
        branch: info.branch || null,
        kind: info.kind || 'git',
        localPath: info.localPath || null,
        lastSync: info.lastSync || null,
        rootPath: repoRoot,
        rootExists: exists,
      };
      return {
        contents: [{
          uri: uri.toString(),
          mimeType: 'application/json',
          text: JSON.stringify(payload, null, 2),
        }],
      };
    },
  );

  // ─ File-as-resource template ───────────────────────────────
  server.registerResource(
    'repo-file',
    new ResourceTemplate('localrepo://{repo}/{+path}', {
      list: async () => {
        const config = await getConfig();
        const resources: Array<{ uri: string; name: string; mimeType?: string; description?: string }> = [];

        for (const [repoName, info] of Object.entries(config.repos)) {
          const repoRoot = repoRootPath(config.storagePath, repoName, info.localPath);
          if (!(await fs.pathExists(repoRoot))) continue;
          let ignore: string[];
          try { ignore = await loadIgnorePatterns(repoRoot); } catch { ignore = []; }
          let files: string[] = [];
          try {
            files = await glob('**/*', {
              cwd: repoRoot,
              dot: false,
              ignore,
              onlyFiles: true,
            });
          } catch {
            continue;
          }
          for (const rel of files.slice(0, MAX_FILES_PER_REPO)) {
            const norm = rel.replace(/\\/g, '/');
            const ext = path.extname(norm).toLowerCase();
            resources.push({
              uri: `localrepo://${repoName}/${norm}`,
              name: `${repoName}: ${norm}`,
              mimeType: mimeTypeFor(ext),
            });
          }
        }
        return { resources };
      },
    }),
    {
      title: 'Repo file',
      description: 'A single file inside a tracked repository.',
    },
    async (uri, vars) => {
      const repoName = String(vars.repo);
      const subPath = Array.isArray(vars.path) ? vars.path.join('/') : String(vars.path);
      const absolute = await resolveRepoPath(repoName, subPath);
      if (!(await fs.pathExists(absolute))) {
        throw new Error(`File not found: ${subPath}`);
      }
      const stat = await fs.stat(absolute);
      if (!stat.isFile()) {
        throw new Error(`Path is not a file: ${subPath}`);
      }
      const ext = path.extname(subPath).toLowerCase();
      if (isBinaryExtension(subPath) || (await looksBinary(absolute))) {
        return {
          contents: [{
            uri: uri.toString(),
            mimeType: mimeTypeFor(ext) ?? 'application/octet-stream',
            text: `[BINARY FILE — ${formatSize(stat.size)} omitted]`,
          }],
        };
      }
      let text: string;
      if (stat.size > MAX_RESOURCE_BYTES) {
        const buf = Buffer.alloc(MAX_RESOURCE_BYTES);
        const fd = await fs.open(absolute, 'r');
        try { await fs.read(fd, buf, 0, MAX_RESOURCE_BYTES, 0); } finally { await fs.close(fd); }
        text = `[WARNING: Truncated from ${formatSize(stat.size)} to ${formatSize(MAX_RESOURCE_BYTES)}]\n\n${buf.toString('utf-8')}`;
      } else {
        text = await fs.readFile(absolute, 'utf-8');
      }
      return {
        contents: [{
          uri: uri.toString(),
          mimeType: mimeTypeFor(ext) ?? 'text/plain',
          text,
        }],
      };
    },
  );
}

function mimeTypeFor(ext: string): string | undefined {
  switch (ext) {
    case '.ts': case '.tsx': case '.js': case '.jsx': case '.mjs': case '.cjs':
      return 'text/typescript';
    case '.json': return 'application/json';
    case '.md': case '.mdx': return 'text/markdown';
    case '.py': return 'text/x-python';
    case '.go': return 'text/x-go';
    case '.rs': return 'text/rust';
    case '.java': return 'text/x-java';
    case '.kt': return 'text/x-kotlin';
    case '.cs': return 'text/x-csharp';
    case '.php': return 'text/x-php';
    case '.rb': return 'text/x-ruby';
    case '.swift': return 'text/x-swift';
    case '.html': return 'text/html';
    case '.css': return 'text/css';
    case '.yaml': case '.yml': return 'application/yaml';
    case '.toml': return 'application/toml';
    case '.xml': return 'application/xml';
    default: return 'text/plain';
  }
}
