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

async function resolveRepoPath(name: string): Promise<string> {
  const config = await getConfig();
  if (!config.repos[name]) throw new Error(`Repository "${name}" not found.`);
  const repoPath = path.resolve(process.cwd(), config.storagePath, name);
  if (!(await fs.pathExists(repoPath))) {
    throw new Error(`Repository directory missing: ${name}`);
  }
  return repoPath;
}

/**
 * Clones a repository to local storage and updates config.
 */
export async function addRepo(url: string, name?: string, branch?: string) {
  const config = await getConfig();
  const normalized = normalizeRepoInput(url, branch);

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
    if (await fs.pathExists(targetPath)) {
      await fs.remove(targetPath);
    }
    throw new Error(`Failed to clone repository: ${error.message}`);
  }
}

export async function syncRepo(name?: string) {
  const config = await getConfig();
  const reposToSync = name && name !== 'all' ? [name] : Object.keys(config.repos);

  if (reposToSync.length === 0) return 'No repositories found to sync.';

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

export async function listRepos() {
  const config = await getConfig();
  const repoList = Object.entries(config.repos);
  if (repoList.length === 0) return 'No repositories added yet.';

  const output = repoList.map(([name, info]) => {
    const branchLabel = info.branch || 'unknown';
    return `- ${name}: ${info.url} [branch: ${branchLabel}] (Last Sync: ${info.lastSync || 'Never'})`;
  }).join('\n');

  return `Managed Repositories:\n${output}`;
}

// ─── NEW: removeRepo ─────────────────────────────────────────

export async function removeRepo(name: string, deleteFiles: boolean = true) {
  const config = await getConfig();
  if (!config.repos[name]) {
    throw new Error(`Repository "${name}" is not tracked.`);
  }

  if (deleteFiles) {
    const repoPath = path.resolve(process.cwd(), config.storagePath, name);
    if (await fs.pathExists(repoPath)) {
      await fs.remove(repoPath);
    }
  }

  delete config.repos[name];
  await saveConfig(config);
  return `Repository "${name}" removed${deleteFiles ? ' (files deleted)' : ' (files kept)'}.`;
}

// ─── NEW: gitLog ─────────────────────────────────────────────

export async function gitLog(
  name: string,
  options: {
    limit?: number;
    file?: string;
    since?: string; // e.g. "2 weeks ago"
  } = {},
) {
  const repoPath = await resolveRepoPath(name);
  const git = simpleGit(repoPath);

  const args: string[] = ['log', '--no-color', `--pretty=format:%h|%ad|%an|%s`, '--date=short'];
  const limit = options.limit ?? 20;
  args.push(`-n`, String(limit));
  if (options.since) args.push(`--since=${options.since}`);
  if (options.file) {
    args.push('--');
    args.push(options.file);
  }

  let raw: string;
  try {
    raw = await git.raw(args);
  } catch (err: any) {
    throw new Error(`git log failed: ${err.message}`);
  }

  const trimmed = raw.trim();
  if (!trimmed) return `No commits found for "${name}"${options.file ? ` (file: ${options.file})` : ''}.`;

  const lines = trimmed.split('\n').map((l) => {
    const parts = l.split('|');
    const sha = parts[0] ?? '';
    const date = parts[1] ?? '';
    const author = parts[2] ?? '';
    const subject = parts.slice(3).join('|');
    return `${sha}  ${date}  ${author.padEnd(20).slice(0, 20)}  ${subject}`;
  });

  let header = `Commits in "${name}"`;
  if (options.file) header += ` (file: ${options.file})`;
  if (options.since) header += ` (since: ${options.since})`;
  header += ` — showing ${lines.length}:\n`;

  return header + lines.join('\n');
}

// ─── NEW: gitShow ────────────────────────────────────────────

const MAX_DIFF_BYTES = 64 * 1024;

export async function gitShow(name: string, sha: string) {
  if (!/^[a-f0-9]{4,40}$/i.test(sha)) {
    throw new Error('Invalid commit SHA. Expected hex string of length 4-40.');
  }
  const repoPath = await resolveRepoPath(name);
  const git = simpleGit(repoPath);

  let raw: string;
  try {
    raw = await git.raw(['show', '--no-color', '--stat', '--patch', sha]);
  } catch (err: any) {
    throw new Error(`git show failed: ${err.message}`);
  }

  if (raw.length > MAX_DIFF_BYTES) {
    return raw.slice(0, MAX_DIFF_BYTES) +
      `\n\n[WARNING: Diff truncated at ${MAX_DIFF_BYTES} bytes — full size: ${raw.length} bytes]`;
  }
  return raw;
}

// ─── NEW: gitDiff ────────────────────────────────────────────

export async function gitDiff(
  name: string,
  options: {
    from?: string;
    to?: string;
    file?: string;
    statOnly?: boolean;
  } = {},
) {
  const repoPath = await resolveRepoPath(name);
  const git = simpleGit(repoPath);

  const args: string[] = ['diff', '--no-color'];
  if (options.statOnly) args.push('--stat');
  if (options.from && options.to) args.push(`${options.from}...${options.to}`);
  else if (options.from) args.push(options.from);
  if (options.file) {
    args.push('--');
    args.push(options.file);
  }

  let raw: string;
  try {
    raw = await git.raw(args);
  } catch (err: any) {
    throw new Error(`git diff failed: ${err.message}`);
  }

  if (!raw.trim()) return 'No differences.';
  if (raw.length > MAX_DIFF_BYTES) {
    return raw.slice(0, MAX_DIFF_BYTES) +
      `\n\n[WARNING: Diff truncated at ${MAX_DIFF_BYTES} bytes — full size: ${raw.length} bytes. Use stat_only=true for summary.]`;
  }
  return raw;
}

// ─── NEW: listBranches ───────────────────────────────────────

export async function listBranches(name: string, includeRemote: boolean = false) {
  const repoPath = await resolveRepoPath(name);
  const git = simpleGit(repoPath);

  const branchInfo = includeRemote
    ? await git.branch(['-a'])
    : await git.branch();

  const out: string[] = [];
  out.push(`Current branch: ${branchInfo.current || '(detached)'}`);
  out.push('');
  out.push('Branches:');
  for (const branch of branchInfo.all) {
    const isCurrent = branch === branchInfo.current;
    out.push(`  ${isCurrent ? '* ' : '  '}${branch}`);
  }
  return out.join('\n');
}

// ─── NEW: listTags ───────────────────────────────────────────

export async function listTags(name: string, limit: number = 50) {
  const repoPath = await resolveRepoPath(name);
  const git = simpleGit(repoPath);

  const tags = await git.tags();
  if (tags.all.length === 0) return `No tags in "${name}".`;

  // Sort tags reverse-alphabetically (newer semver tends to come last alphabetically, so reverse)
  const sorted = [...tags.all].sort().reverse();
  const sliced = sorted.slice(0, limit);
  let out = `Tags in "${name}" (${tags.all.length} total):\n`;
  out += sliced.join('\n');
  if (sorted.length > limit) out += `\n... and ${sorted.length - limit} more`;
  return out;
}
