import simpleGit from 'simple-git';
import path from 'path';
import fs from 'fs-extra';
import { getConfig, saveConfig } from '../config';

/**
 * Clones a repository to local storage and updates config.
 */
export async function addRepo(url: string, name?: string) {
  const config = await getConfig();
  
  // Basic security: avoid directory traversal
  const safeName = (name || url.split('/').pop()?.replace('.git', '') || 'unknown')
    .replace(/[\\/..]/g, '_');
    
  const targetPath = path.resolve(process.cwd(), config.storagePath, safeName);

  if (await fs.pathExists(targetPath)) {
    throw new Error(`Repository directory "${safeName}" already exists in storage.`);
  }

  await fs.ensureDir(path.dirname(targetPath));
  
  const git = simpleGit();
  try {
    console.error(`Cloning ${url} into ${targetPath}...`);
    await git.clone(url, targetPath);

    config.repos[safeName] = {
      url,
      branch: 'main',
      lastSync: new Date().toISOString(),
    };

    await saveConfig(config);
    return `Repository "${safeName}" cloned successfully.`;
  } catch (error: any) {
    // Cleanup if directory was created but clone failed
    if (await fs.pathExists(targetPath)) {
      await fs.remove(targetPath);
    }
    throw new Error(`Failed to clone repository: ${error.message}`);
  }
}

/**
 * Syncs (pulls) latest changes for one or all repositories.
 */
export async function syncRepo(name?: string) {
  const config = await getConfig();
  const reposToSync = name && name !== 'all' 
    ? [name] 
    : Object.keys(config.repos);

  if (reposToSync.length === 0) {
    return "No repositories found to sync.";
  }

  const results: string[] = [];
  for (const repoName of reposToSync) {
    const repo = config.repos[repoName];
    if (!repo) {
      results.push(`Repo "${repoName}" not found in config.`);
      continue;
    }

    const targetPath = path.resolve(process.cwd(), config.storagePath, repoName);
    if (!(await fs.pathExists(targetPath))) {
      results.push(`Repo "${repoName}" directory missing in storage.`);
      continue;
    }

    try {
      const git = simpleGit(targetPath);
      await git.pull();
      repo.lastSync = new Date().toISOString();
      results.push(`Successfully synced "${repoName}"`);
    } catch (error: any) {
      results.push(`Failed to sync "${repoName}": ${error.message}`);
    }
  }

  await saveConfig(config);
  return results.join('\n');
}

/**
 * Lists all managed repositories.
 */
export async function listRepos() {
  const config = await getConfig();
  const repoList = Object.entries(config.repos);
  
  if (repoList.length === 0) {
    return "No repositories added yet.";
  }

  const output = repoList.map(([name, info]) => {
    return `- ${name}: ${info.url} (Last Sync: ${info.lastSync || 'Never'})`;
  }).join('\n');

  return `Managed Repositories:\n${output}`;
}