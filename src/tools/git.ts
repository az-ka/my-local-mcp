import simpleGit from 'simple-git';
import path from 'path';
import fs from 'fs-extra';
import { getConfig, saveConfig } from '../config';

export type NormalizedRepoInput = {
  cloneUrl: string;
  storedUrl: string;
  branch?: string;
  inferredName: string;
};

export function normalizeRepoInput(rawUrl: string, rawBranch?: string): NormalizedRepoInput {
  const trimmedUrl = rawUrl.trim();
  const normalizedUrl = /^https?:\/\//i.test(trimmedUrl) ? trimmedUrl : `https://${trimmedUrl}`;
  const parsedUrl = new URL(normalizedUrl);

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('Only HTTP(S) repository URLs are supported.');
  }
  const pathSegments = parsedUrl.pathname.split('/').filter(Boolean);

  if (pathSegments.length < 2) {
    throw new Error('Repository URL must include both owner and repository name.');
  }

  const owner = pathSegments[0]!;
  const repoSegment = pathSegments[1]!;
  const rest = pathSegments.slice(2);
  const repoName = repoSegment.replace(/\.git$/i, '');
  let branch = rawBranch?.trim();

  if (rest[0] === 'tree') {
    const treeBranch = rest.slice(1).join('/').trim();
    if (!treeBranch) {
      throw new Error('GitHub tree URL must include a branch name after "tree/".');
    }
    branch = branch || treeBranch;
  } else if (rest.length > 0) {
    throw new Error('Only repository root URLs or GitHub tree/<branch> URLs are supported.');
  }

  parsedUrl.pathname = `/${owner}/${repoName}`;
  parsedUrl.search = '';
  parsedUrl.hash = '';

  return {
    cloneUrl: parsedUrl.toString(),
    storedUrl: parsedUrl.toString(),
    branch: branch || undefined,
    inferredName: repoName,
  };
}

async function getCurrentBranch(repoPath: string): Promise<string | undefined> {
  const git = simpleGit(repoPath);
  const branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
  return branch && branch !== 'HEAD' ? branch : undefined;
}

/**
 * Clones a repository to local storage and updates config.
 */
export async function addRepo(url: string, name?: string, branch?: string) {
  const config = await getConfig();
  const normalized = normalizeRepoInput(url, branch);
  
  // Basic security: avoid directory traversal
  const safeName = (name || normalized.inferredName || 'unknown')
    .replace(/[\\/.]/g, '_')
    .replace(/_{2,}/g, '_');
     
  const targetPath = path.resolve(process.cwd(), config.storagePath, safeName);

  if (await fs.pathExists(targetPath)) {
    throw new Error(`Repository directory "${safeName}" already exists in storage.`);
  }

  await fs.ensureDir(path.dirname(targetPath));
  
  const git = simpleGit();
  try {
    console.error(`Cloning ${normalized.cloneUrl} into ${targetPath}...`);

    const cloneOptions = normalized.branch
      ? ['--branch', normalized.branch, '--single-branch']
      : undefined;

    await git.clone(normalized.cloneUrl, targetPath, cloneOptions);
    const activeBranch = await getCurrentBranch(targetPath);

    config.repos[safeName] = {
      url: normalized.storedUrl,
      branch: activeBranch || normalized.branch,
      lastSync: new Date().toISOString(),
    };

    await saveConfig(config);
    const branchSuffix = config.repos[safeName].branch
      ? ` on branch "${config.repos[safeName].branch}"`
      : '';

    return `Repository "${safeName}" cloned successfully${branchSuffix}.`;
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
      const activeBranch = await getCurrentBranch(targetPath);

      if (activeBranch) {
        repo.branch = activeBranch;
        await git.pull('origin', activeBranch);
      } else {
        await git.pull();
      }

      repo.lastSync = new Date().toISOString();
      const branchSuffix = repo.branch ? ` on branch "${repo.branch}"` : '';
      results.push(`Successfully synced "${repoName}"${branchSuffix}`);
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
    const branchLabel = info.branch || 'unknown';
    return `- ${name}: ${info.url} [branch: ${branchLabel}] (Last Sync: ${info.lastSync || 'Never'})`;
  }).join('\n');

  return `Managed Repositories:\n${output}`;
}
