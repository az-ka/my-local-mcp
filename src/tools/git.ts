import simpleGit from 'simple-git';
import path from 'path';
import fs from 'fs-extra';
import glob from 'fast-glob';
import { getConfig, saveConfig, getEnvSettings } from '../config';
import {
  ToolError,
  resolveRepoPath,
  repoRootPath,
  formatSize,
  debug,
  invalidateIgnore,
  DEFAULT_IGNORE_PATTERNS,
} from '../shared';

// ─── URL normalization ───────────────────────────────────────

export type NormalizedRepoInput = {
  /** URL used for `git clone`. */
  cloneUrl: string;
  /** URL stored in settings (no token leaked). */
  storedUrl: string;
  /** Branch name to check out after clone (when known). */
  branch?: string;
  /** Tag name (used only as a hint; tags are checked out as detached). */
  tag?: string;
  /** Commit SHA to check out (detached HEAD). */
  commit?: string;
  /** Inferred repo name (last URL segment, sans `.git`). */
  inferredName: string;
};

/**
 * Accepts:
 *   - `owner/repo` (HTTPS assumed)
 *   - `https://github.com/owner/repo`
 *   - `.../tree/<branch[/sub/path]>`         → branch hint
 *   - `.../commit/<sha>`                     → commit hint
 *   - `.../releases/tag/<tag>`               → tag hint
 *   - `.../tag/<tag>`                        → tag hint
 *
 * Rejects file-level URLs (`blob/...`, `raw/...`).
 */
export function normalizeRepoInput(rawUrl: string, rawBranch?: string): NormalizedRepoInput {
  const trimmedUrl = rawUrl.trim();
  const normalizedUrl = /^https?:\/\//i.test(trimmedUrl) ? trimmedUrl : `https://${trimmedUrl}`;
  const parsedUrl = new URL(normalizedUrl);

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new ToolError('INVALID_INPUT', 'Only HTTP(S) repository URLs are supported.');
  }
  const pathSegments = parsedUrl.pathname.split('/').filter(Boolean);

  if (pathSegments.length < 2) {
    throw new ToolError('INVALID_INPUT', 'Repository URL must include both owner and repository name.');
  }

  const owner = pathSegments[0]!;
  const repoSegment = pathSegments[1]!;
  const rest = pathSegments.slice(2);
  const repoName = repoSegment.replace(/\.git$/i, '');
  let branch = rawBranch?.trim() || undefined;
  let tag: string | undefined;
  let commit: string | undefined;

  if (rest.length > 0) {
    const head = rest[0];
    if (head === 'tree') {
      const treeBranch = rest.slice(1).join('/').trim();
      if (!treeBranch) throw new ToolError('INVALID_INPUT', 'GitHub tree URL must include a branch name after "tree/".');
      branch = branch || treeBranch;
    } else if (head === 'commit' && rest[1]) {
      if (!/^[a-f0-9]{4,40}$/i.test(rest[1])) {
        throw new ToolError('INVALID_INPUT', `Invalid commit SHA in URL: ${rest[1]}`);
      }
      commit = rest[1];
    } else if (head === 'tag' && rest[1]) {
      tag = rest.slice(1).join('/');
    } else if (head === 'releases' && rest[1] === 'tag' && rest[2]) {
      tag = rest.slice(2).join('/');
    } else if (head === 'blob' || head === 'raw') {
      throw new ToolError('INVALID_INPUT',
        'File-level URLs (blob/raw) are not supported. Only repository root URLs or GitHub tree/commit/releases/tag URLs are supported.',
        'Use the repository root URL, or a tree/commit/tag URL.');
    } else {
      throw new ToolError('INVALID_INPUT',
        'Only repository root URLs or GitHub tree/commit/releases/tag URLs are supported.');
    }
  }

  parsedUrl.pathname = `/${owner}/${repoName}`;
  parsedUrl.search = '';
  parsedUrl.hash = '';

  return {
    cloneUrl: parsedUrl.toString(),
    storedUrl: parsedUrl.toString(),
    branch,
    tag,
    commit,
    inferredName: repoName,
  };
}

/** Inject `MCP_GITHUB_TOKEN` into an HTTPS GitHub URL (token never stored). */
function withAuth(url: string): string {
  const env = getEnvSettings();
  if (!env.githubToken) return url;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return url;
    // Only inject for github.com to avoid leaking to unrelated hosts.
    if (!u.hostname.endsWith('github.com')) return url;
    u.username = 'x-access-token';
    u.password = env.githubToken;
    return u.toString();
  } catch {
    return url;
  }
}

// ─── Internal helpers ────────────────────────────────────────

async function getCurrentBranch(repoPath: string): Promise<string | undefined> {
  const git = simpleGit(repoPath);
  try {
    const branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
    return branch && branch !== 'HEAD' ? branch : undefined;
  } catch {
    return undefined;
  }
}

async function getRepoKind(name: string): Promise<'git' | 'local'> {
  const config = await getConfig();
  return config.repos[name]?.kind || 'git';
}

/** Throws ToolError(NOT_A_DIR) if the tracked entry isn't a git repo. */
async function requireGit(name: string): Promise<string> {
  const kind = await getRepoKind(name);
  if (kind === 'local') {
    throw new ToolError(
      'INVALID_INPUT',
      `"${name}" is a local non-git folder; git operations are unavailable.`,
      'Use file/code exploration tools instead, or re-register as a git repo.',
    );
  }
  return resolveRepoPath(name);
}

/** Recursively compute folder size (best-effort, used only for warnings). */
async function dirSize(root: string): Promise<number> {
  let total = 0;
  const entries = await glob('**/*', { cwd: root, dot: false, onlyFiles: true, ignore: DEFAULT_IGNORE_PATTERNS });
  for (const e of entries) {
    try {
      const st = await fs.stat(path.join(root, e));
      total += st.size;
    } catch {
      // skip
    }
  }
  return total;
}

// ─── addRepo ─────────────────────────────────────────────────

export interface AddRepoOptions {
  /** Override clone depth. 0 = full history. */
  depth?: number;
  /** When true, ignore the size warning threshold. */
  ignoreSizeWarning?: boolean;
}

/**
 * Clones a repository to local storage and updates config.
 * Accepts tree/commit/tag URL variants; checks out the appropriate ref.
 */
export async function addRepo(
  url: string,
  name?: string,
  branch?: string,
  options: AddRepoOptions = {},
) {
  const config = await getConfig();
  const env = getEnvSettings();
  const normalized = normalizeRepoInput(url, branch);

  const safeName = (name || normalized.inferredName || 'unknown')
    .replace(/[\\/.]/g, '_')
    .replace(/_{2,}/g, '_');

  if (config.repos[safeName]) {
    throw new ToolError('REPO_ALREADY_EXISTS', `Repository "${safeName}" is already tracked.`);
  }

  const targetPath = path.resolve(process.cwd(), config.storagePath, safeName);

  if (await fs.pathExists(targetPath)) {
    throw new ToolError(
      'REPO_ALREADY_EXISTS',
      `Repository directory "${safeName}" already exists in storage.`,
    );
  }

  await fs.ensureDir(path.dirname(targetPath));

  const depth = options.depth ?? env.cloneDepth;
  const cloneOptions: string[] = [];
  if (normalized.branch) {
    cloneOptions.push('--branch', normalized.branch, '--single-branch');
  }
  if (depth > 0 && !normalized.commit) {
    cloneOptions.push('--depth', String(depth));
  }

  const cloneUrl = withAuth(normalized.cloneUrl);
  const git = simpleGit();
  try {
    debug(`clone ${normalized.cloneUrl} → ${targetPath}`, { depth, branch: normalized.branch });
    console.error(`Cloning ${normalized.cloneUrl} into ${targetPath}...`);
    await git.clone(cloneUrl, targetPath, cloneOptions.length ? cloneOptions : undefined);

    // Checkout commit or tag (detached) if requested.
    if (normalized.commit) {
      await simpleGit(targetPath).checkout([normalized.commit]);
    } else if (normalized.tag && !normalized.branch) {
      await simpleGit(targetPath).checkout([`tags/${normalized.tag}`]);
    }

    const activeBranch = await getCurrentBranch(targetPath);

    config.repos[safeName] = {
      url: normalized.storedUrl,
      branch: activeBranch || normalized.branch,
      lastSync: new Date().toISOString(),
      kind: 'git',
    };

    await saveConfig(config);
    invalidateIgnore(targetPath);

    let suffix = '';
    if (activeBranch) suffix = ` on branch "${activeBranch}"`;
    else if (normalized.commit) suffix = ` at commit ${normalized.commit.slice(0, 8)}`;
    else if (normalized.tag) suffix = ` at tag ${normalized.tag}`;

    let warnings = '';
    if (!options.ignoreSizeWarning) {
      try {
        const size = await dirSize(targetPath);
        if (size > env.maxRepoBytes) {
          warnings = `\n[WARNING: Repo size ${formatSize(size)} exceeds threshold ${formatSize(env.maxRepoBytes)}. Consider shallow clone with depth.]`;
        }
      } catch {
        // ignore
      }
    }

    return `Repository "${safeName}" cloned successfully${suffix}.${warnings}`;
  } catch (error: any) {
    if (await fs.pathExists(targetPath)) {
      await fs.remove(targetPath);
    }
    throw new ToolError('CLONE_FAILED', `Failed to clone repository: ${error.message}`);
  }
}

// ─── addLocalFolder ──────────────────────────────────────────

/**
 * Register an existing local folder as a tracked entry without cloning.
 * Useful for project repos already on disk. Git ops will still work if
 * the folder is a git checkout.
 */
export async function addLocalFolder(localPath: string, name?: string) {
  const absolute = path.isAbsolute(localPath) ? localPath : path.resolve(process.cwd(), localPath);
  if (!(await fs.pathExists(absolute))) {
    throw new ToolError('PATH_NOT_FOUND', `Local path not found: ${absolute}`);
  }
  const stat = await fs.stat(absolute);
  if (!stat.isDirectory()) {
    throw new ToolError('NOT_A_DIR', `Local path is not a directory: ${absolute}`);
  }

  const safeName = (name || path.basename(absolute) || 'local')
    .replace(/[\\/.]/g, '_')
    .replace(/_{2,}/g, '_');

  const config = await getConfig();
  if (config.repos[safeName]) {
    throw new ToolError('REPO_ALREADY_EXISTS', `Name "${safeName}" already used by another repo.`);
  }

  // Detect if it's a git checkout, just for nicer metadata.
  let kind: 'git' | 'local' = 'local';
  let branch: string | undefined;
  if (await fs.pathExists(path.join(absolute, '.git'))) {
    kind = 'git';
    branch = await getCurrentBranch(absolute);
  }

  config.repos[safeName] = {
    url: '',
    branch,
    lastSync: new Date().toISOString(),
    localPath: absolute,
    kind,
  };
  await saveConfig(config);
  return `Local folder "${absolute}" registered as "${safeName}" (kind: ${kind}).`;
}

// ─── syncRepo ────────────────────────────────────────────────

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
    if (repo.kind === 'local' || (!repo.url && repo.localPath)) {
      results.push(`Skipped "${repoName}" (local folder, not a git clone).`);
      continue;
    }

    const targetPath = repoRootPath(config.storagePath, repoName, repo.localPath);
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
      invalidateIgnore(targetPath);
    } catch (error: any) {
      results.push(`Failed to sync "${repoName}": ${error.message}`);
    }
  }

  await saveConfig(config);
  return results.join('\n');
}

// ─── listRepos ───────────────────────────────────────────────

export interface ListReposOptions {
  /** Substring filter (case-insensitive) against repo name. */
  filter?: string;
  /** Sort key. Default: name. */
  sort?: 'name' | 'lastSync' | 'branch';
}

export async function listRepos(options: ListReposOptions = {}) {
  const config = await getConfig();
  let repoList = Object.entries(config.repos);
  if (repoList.length === 0) return 'No repositories added yet.';

  if (options.filter) {
    const needle = options.filter.toLowerCase();
    repoList = repoList.filter(([n]) => n.toLowerCase().includes(needle));
  }
  switch (options.sort) {
    case 'lastSync':
      repoList.sort((a, b) => (b[1].lastSync || '').localeCompare(a[1].lastSync || ''));
      break;
    case 'branch':
      repoList.sort((a, b) => (a[1].branch || '').localeCompare(b[1].branch || ''));
      break;
    case 'name':
    default:
      repoList.sort((a, b) => a[0].localeCompare(b[0]));
      break;
  }

  if (repoList.length === 0) return 'No repositories matched the filter.';

  const output = repoList.map(([name, info]) => {
    const branchLabel = info.branch || 'unknown';
    const kindLabel = info.kind === 'local' ? ' [local]' : '';
    const where = info.localPath ? ` @${info.localPath}` : '';
    const urlLabel = info.url || '(local-only)';
    return `- ${name}${kindLabel}: ${urlLabel}${where} [branch: ${branchLabel}] (Last Sync: ${info.lastSync || 'Never'})`;
  }).join('\n');

  return `Managed Repositories (${repoList.length}):\n${output}`;
}

// ─── removeRepo ──────────────────────────────────────────────

export async function removeRepo(name: string, deleteFiles: boolean = true) {
  const config = await getConfig();
  if (!config.repos[name]) {
    throw new ToolError('REPO_NOT_FOUND', `Repository "${name}" is not tracked.`);
  }
  const info = config.repos[name];

  if (deleteFiles) {
    // Never delete a user-registered local folder; only `storage/<name>` clones.
    if (info.kind === 'local' || info.localPath) {
      // soft skip
    } else {
      const repoPath = path.resolve(process.cwd(), config.storagePath, name);
      if (await fs.pathExists(repoPath)) {
        await fs.remove(repoPath);
      }
      invalidateIgnore(repoPath);
    }
  }

  delete config.repos[name];
  await saveConfig(config);
  const action = info.kind === 'local' || info.localPath
    ? ' (un-tracked; local folder left in place)'
    : deleteFiles ? ' (files deleted)' : ' (files kept)';
  return `Repository "${name}" removed${action}.`;
}

// ─── gitLog ──────────────────────────────────────────────────

export async function gitLog(
  name: string,
  options: {
    limit?: number;
    file?: string;
    since?: string;
  } = {},
) {
  const repoPath = await requireGit(name);
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
    throw new ToolError('GIT_FAILED', `git log failed: ${err.message}`);
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

// ─── gitShow ─────────────────────────────────────────────────

const MAX_DIFF_BYTES = 64 * 1024;

export async function gitShow(name: string, sha: string) {
  if (!/^[a-f0-9]{4,40}$/i.test(sha)) {
    throw new ToolError('INVALID_INPUT', 'Invalid commit SHA. Expected hex string of length 4-40.');
  }
  const repoPath = await requireGit(name);
  const git = simpleGit(repoPath);

  let raw: string;
  try {
    raw = await git.raw(['show', '--no-color', '--stat', '--patch', sha]);
  } catch (err: any) {
    throw new ToolError('GIT_FAILED', `git show failed: ${err.message}`);
  }

  if (raw.length > MAX_DIFF_BYTES) {
    return raw.slice(0, MAX_DIFF_BYTES) +
      `\n\n[WARNING: Diff truncated at ${MAX_DIFF_BYTES} bytes — full size: ${raw.length} bytes]`;
  }
  return raw;
}

// ─── gitDiff ─────────────────────────────────────────────────

export async function gitDiff(
  name: string,
  options: {
    from?: string;
    to?: string;
    file?: string;
    statOnly?: boolean;
  } = {},
) {
  const repoPath = await requireGit(name);
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
    throw new ToolError('GIT_FAILED', `git diff failed: ${err.message}`);
  }

  if (!raw.trim()) return 'No differences.';
  if (raw.length > MAX_DIFF_BYTES) {
    return raw.slice(0, MAX_DIFF_BYTES) +
      `\n\n[WARNING: Diff truncated at ${MAX_DIFF_BYTES} bytes — full size: ${raw.length} bytes. Use stat_only=true for summary.]`;
  }
  return raw;
}

// ─── listBranches ────────────────────────────────────────────

export async function listBranches(name: string, includeRemote: boolean = false) {
  const repoPath = await requireGit(name);
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

// ─── listTags ────────────────────────────────────────────────

export async function listTags(name: string, limit: number = 50) {
  const repoPath = await requireGit(name);
  const git = simpleGit(repoPath);

  const tags = await git.tags();
  if (tags.all.length === 0) return `No tags in "${name}".`;

  const sorted = [...tags.all].sort().reverse();
  const sliced = sorted.slice(0, limit);
  let out = `Tags in "${name}" (${tags.all.length} total):\n`;
  out += sliced.join('\n');
  if (sorted.length > limit) out += `\n... and ${sorted.length - limit} more`;
  return out;
}

// ─── gitBlame ────────────────────────────────────────────────

export interface GitBlameOptions {
  /** 1-indexed start line. */
  startLine?: number;
  /** 1-indexed inclusive end line. */
  endLine?: number;
}

/**
 * Annotates each line of `file` with the commit that last touched it.
 * Range bounds default to the whole file but are clamped to file length.
 * Output is compact:
 *   `<sha8>  <author>  <date>  <line#>: <code>`
 */
export async function gitBlame(name: string, file: string, options: GitBlameOptions = {}) {
  const repoPath = await requireGit(name);
  const absolute = await resolveRepoPath(name, file);
  if (!(await fs.pathExists(absolute))) {
    throw new ToolError('PATH_NOT_FOUND', `File not found: ${file}`);
  }
  const stat = await fs.stat(absolute);
  if (!stat.isFile()) throw new ToolError('NOT_A_FILE', `Path is not a file: ${file}`);

  const git = simpleGit(repoPath);
  const args = ['blame', '--line-porcelain'];
  if (options.startLine && options.endLine) {
    args.push('-L', `${options.startLine},${options.endLine}`);
  } else if (options.startLine) {
    args.push('-L', `${options.startLine},+200`);
  }
  args.push('HEAD', '--', file);

  let raw: string;
  try {
    raw = await git.raw(args);
  } catch (err: any) {
    throw new ToolError('GIT_FAILED', `git blame failed: ${err.message}`);
  }

  // Parse porcelain output into compact lines.
  const blocks = raw.split(/\n(?=[0-9a-f]{40} )/);
  const lines: string[] = [];
  for (const block of blocks) {
    if (!block.trim()) continue;
    const blockLines = block.split('\n');
    const header = blockLines[0] || '';
    const sha = header.slice(0, 8);
    const headerParts = header.split(' ');
    const finalLineNum = headerParts[2] || '?';
    let author = '?';
    let date = '?';
    let codeLine = '';
    for (const l of blockLines) {
      if (l.startsWith('author ')) author = l.slice(7);
      else if (l.startsWith('author-time ')) {
        const t = Number(l.slice(12));
        if (Number.isFinite(t)) date = new Date(t * 1000).toISOString().slice(0, 10);
      } else if (l.startsWith('\t')) {
        codeLine = l.slice(1);
      }
    }
    lines.push(`${sha}  ${author.padEnd(15).slice(0, 15)}  ${date}  ${finalLineNum.padStart(5)}: ${codeLine}`);
  }
  if (lines.length === 0) return `No blame output for ${file}.`;
  return `Blame for ${file} (${lines.length} line(s)):\n${lines.join('\n')}`;
}

// ─── gitStatus ───────────────────────────────────────────────

/**
 * Reports working-tree status. Generally empty for cloned repos, but useful
 * when the user registered a local folder they edit themselves.
 */
export async function gitStatus(name: string) {
  const repoPath = await requireGit(name);
  const git = simpleGit(repoPath);
  let status;
  try {
    status = await git.status();
  } catch (err: any) {
    throw new ToolError('GIT_FAILED', `git status failed: ${err.message}`);
  }
  if (status.isClean()) return `Working tree clean for "${name}" (branch: ${status.current || '(detached)'}).`;

  const buckets: Array<[string, string[]]> = [
    ['Staged', status.staged],
    ['Modified', status.modified],
    ['Created', status.created],
    ['Deleted', status.deleted],
    ['Renamed', status.renamed.map((r) => `${r.from} → ${r.to}`)],
    ['Conflicted', status.conflicted],
    ['Not added', status.not_added],
  ];
  const out: string[] = [`Status for "${name}" (branch: ${status.current || '(detached)'}):`];
  for (const [label, items] of buckets) {
    if (items.length > 0) {
      out.push(`\n${label} (${items.length}):`);
      for (const i of items) out.push(`  ${i}`);
    }
  }
  return out.join('\n');
}

// ─── gitGrep ─────────────────────────────────────────────────

export interface GitGrepOptions {
  /** Treat query as fixed string (default true). */
  fixedStrings?: boolean;
  /** Case-insensitive match. */
  ignoreCase?: boolean;
  /** Restrict to a path (relative to repo root). */
  path?: string;
  /** Max matches to return. */
  maxResults?: number;
}

/**
 * Fast text search using `git grep`. Honors `.gitignore` automatically and
 * is typically 5-10x faster than walking the FS for large repos.
 */
export async function gitGrep(name: string, query: string, options: GitGrepOptions = {}) {
  const repoPath = await requireGit(name);
  const git = simpleGit(repoPath);

  const args: string[] = ['grep', '--no-color', '-n'];
  if (options.fixedStrings !== false) args.push('-F');
  if (options.ignoreCase) args.push('-i');
  args.push('--', query);
  if (options.path) args.push(options.path);

  let raw = '';
  try {
    raw = await git.raw(args);
  } catch (err: any) {
    // git grep exits 1 when no matches found — not an error for us.
    const stderr = String(err?.message || '');
    if (stderr.includes('exit code 1') || stderr.trim() === '') {
      return `No matches for "${query}" in "${name}".`;
    }
    throw new ToolError('GIT_FAILED', `git grep failed: ${stderr}`);
  }

  const lines = raw.split('\n').filter((l) => l.length > 0);
  if (lines.length === 0) return `No matches for "${query}" in "${name}".`;
  const max = options.maxResults ?? 100;
  const sliced = lines.slice(0, max);
  let out = `${lines.length} match(es) for "${query}" in "${name}"`;
  if (lines.length > max) out += ` (showing first ${max})`;
  out += ':\n' + sliced.join('\n');
  return out;
}
