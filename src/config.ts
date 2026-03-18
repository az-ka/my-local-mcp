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

export const RepoSchema = z.object({
  url: z.string().regex(/^(https?:\/\/)?([\da-z\.-]+)\.([a-z\.]{2,6})([\/\w \.-]*)*\/?$/, "Invalid URL format"),
  branch: z.string().optional(),
  lastSync: z.string().optional(),
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
