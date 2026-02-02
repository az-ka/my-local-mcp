import fs from 'fs-extra';
import path from 'path';
import { z } from 'zod';

export const RepoSchema = z.object({
  url: z.string().regex(/^(https?:\/\/)?([\da-z\.-]+)\.([a-z\.]{2,6})([\/\w \.-]*)*\/?$/, "Invalid URL format"),
  branch: z.string().optional().default('main'),
  lastSync: z.string().optional(),
});

export const ConfigSchema = z.object({
  storagePath: z.string().default('./storage'),
  repos: z.record(z.string(), RepoSchema).default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type RepoInfo = z.infer<typeof RepoSchema>;

const CONFIG_FILE = path.join(process.cwd(), 'settings.json');

export async function getConfig(): Promise<Config> {
  try {
    if (!(await fs.pathExists(CONFIG_FILE))) {
      const defaultConfig: Config = { storagePath: './storage', repos: {} };
      await fs.writeJSON(CONFIG_FILE, defaultConfig, { spaces: 2 });
      return defaultConfig;
    }
    const data = await fs.readJSON(CONFIG_FILE);
    return ConfigSchema.parse(data);
  } catch (error) {
    console.error('Error reading config:', error);
    return { storagePath: './storage', repos: {} };
  }
}

export async function saveConfig(config: Config): Promise<void> {
  await fs.writeJSON(CONFIG_FILE, config, { spaces: 2 });
}