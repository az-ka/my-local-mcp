import fs from 'fs-extra';
import path from 'path';
import { z } from 'zod';

// Determine if we are running as a compiled binary or via bun runtime
const isBinary = !process.execPath.endsWith('bun') && !process.execPath.endsWith('bun.exe');

// Calculate absolute base directory
// If binary: use the folder where the .exe file is located
// If source: use the project root (one level up from src/)
const BASE_DIR = isBinary
  ? path.dirname(process.execPath)
  : path.resolve(import.meta.dir, '..');

console.error(`[Config] Base Directory resolved to: ${BASE_DIR}`);

/**
 * Repository entry.
 *
 * - `url`: original clone URL (empty string for local folders).
 * - `branch`: active branch, when known.
 * - `lastSync`: ISO timestamp of last successful pull or clone.
 * - `localPath`: when set, points at a folder outside `storage/` that the
 *   server should treat as a managed repo (git or otherwise). Tools that
 *   require git ops will fail gracefully on non-git folders.
 * - `kind`: 'git' | 'local'. Defaults to 'git' for backward compatibility.
 */
export const RepoSchema = z.object({
  url: z.string(),
  branch: z.string().optional(),
  lastSync: z.string().optional(),
  localPath: z.string().optional(),
  kind: z.enum(['git', 'local']).optional(),
});

export const ConfigSchema = z.object({
  storagePath: z.string().default(path.join(BASE_DIR, 'storage')),
  repos: z.record(z.string(), RepoSchema).default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type RepoInfo = z.infer<typeof RepoSchema>;

const CONFIG_FILE = path.join(BASE_DIR, 'settings.json');

export async function getConfig(): Promise<Config> {
  try {
    const defaultStoragePath = path.join(BASE_DIR, 'storage');

    if (!(await fs.pathExists(CONFIG_FILE))) {
      const defaultConfig: Config = { storagePath: defaultStoragePath, repos: {} };
      await fs.writeJSON(CONFIG_FILE, defaultConfig, { spaces: 2 });
      return defaultConfig;
    }

    const data = await fs.readJSON(CONFIG_FILE);
    const parsed = ConfigSchema.parse(data);

    // Ensure storagePath is absolute
    if (!path.isAbsolute(parsed.storagePath)) {
      parsed.storagePath = path.resolve(BASE_DIR, parsed.storagePath);
    }

    return parsed;
  } catch (error) {
    console.error('Error reading config:', error);
    return { storagePath: path.join(BASE_DIR, 'storage'), repos: {} };
  }
}

export async function saveConfig(config: Config): Promise<void> {
  await fs.writeJSON(CONFIG_FILE, config, { spaces: 2 });
}

/**
 * Optional env-driven settings.
 *
 * `MCP_GITHUB_TOKEN` is injected into HTTPS clone URLs so private repos
 * work without leaving the token in `settings.json`. We accept either
 * `MCP_GITHUB_TOKEN` or the standard `GITHUB_TOKEN`.
 *
 * `MCP_CLONE_DEPTH` (number, default 0 = full history) clamps clone depth.
 * `MCP_MAX_REPO_BYTES` (number) warns if a freshly-cloned repo exceeds it.
 */
export interface EnvSettings {
  githubToken?: string;
  cloneDepth: number;
  maxRepoBytes: number;
}

export function getEnvSettings(): EnvSettings {
  const token = process.env.MCP_GITHUB_TOKEN || process.env.GITHUB_TOKEN || undefined;
  const depthRaw = process.env.MCP_CLONE_DEPTH;
  const depth = depthRaw ? Number(depthRaw) : 0;
  const maxRaw = process.env.MCP_MAX_REPO_BYTES;
  const max = maxRaw ? Number(maxRaw) : 2 * 1024 * 1024 * 1024; // 2GB default warn
  return {
    githubToken: token,
    cloneDepth: Number.isFinite(depth) && depth > 0 ? Math.floor(depth) : 0,
    maxRepoBytes: Number.isFinite(max) && max > 0 ? Math.floor(max) : 2 * 1024 * 1024 * 1024,
  };
}
