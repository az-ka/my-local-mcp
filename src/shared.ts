/**
 * Shared helpers used across tools.
 *
 * Why this module exists:
 *   - Single source of truth for error shape, ignore patterns, binary detection,
 *     debug logging and a tiny TTL cache.
 *   - Tools previously duplicated this logic; centralizing it shrinks the
 *     surface where regressions can hide.
 */
import fs from 'fs-extra';
import path from 'path';
import { getConfig } from './config';

// ─── Structured tool errors ──────────────────────────────────

export type ToolErrorCode =
  | 'REPO_NOT_FOUND'
  | 'REPO_DIR_MISSING'
  | 'REPO_ALREADY_EXISTS'
  | 'PATH_NOT_FOUND'
  | 'PATH_TRAVERSAL'
  | 'INVALID_INPUT'
  | 'INVALID_REGEX'
  | 'CLONE_FAILED'
  | 'GIT_FAILED'
  | 'TOO_LARGE'
  | 'NOT_A_FILE'
  | 'NOT_A_DIR'
  | 'INTERNAL';

export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly hint?: string;
  constructor(code: ToolErrorCode, message: string, hint?: string) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.name = 'ToolError';
  }
}

/**
 * Wraps a thrown error into a structured payload suitable for an MCP tool
 * response. Preserves ToolError details when present; falls back to
 * `INTERNAL` for unknown throws.
 */
export function describeError(err: unknown): { code: ToolErrorCode; message: string; hint?: string } {
  if (err instanceof ToolError) return { code: err.code, message: err.message, hint: err.hint };
  const message = err instanceof Error ? err.message : String(err);
  return { code: 'INTERNAL', message };
}

/**
 * Build the `text` body of an error MCP response.
 * Includes the code so AI clients can branch on it without parsing prose.
 */
export function formatErrorText(err: unknown): string {
  const e = describeError(err);
  let out = `[${e.code}] ${e.message}`;
  if (e.hint) out += `\nHint: ${e.hint}`;
  return out;
}

// ─── Debug logger ────────────────────────────────────────────

const DEBUG_ENABLED = (() => {
  const v = process.env.MCP_DEBUG;
  if (!v) return false;
  return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes';
})();

export function debug(label: string, ...args: unknown[]): void {
  if (!DEBUG_ENABLED) return;
  const ts = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.error(`[debug ${ts}] ${label}`, ...args);
}

export function isDebugEnabled(): boolean {
  return DEBUG_ENABLED;
}

/** Time an async operation; only logs when MCP_DEBUG is set. */
export async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (!DEBUG_ENABLED) return fn();
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    const ms = (performance.now() - t0).toFixed(1);
    debug(`${label} (${ms}ms)`);
  }
}

// ─── Tiny TTL cache ──────────────────────────────────────────

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

/**
 * In-process TTL cache. Suitable for caching directory listings or symbol
 * scans where invalidation on repo mutation is straightforward (we expose
 * `invalidate(prefix)`).
 */
export class TtlCache<V> {
  private readonly store = new Map<string, CacheEntry<V>>();
  constructor(private readonly defaultTtlMs: number) {}

  get(key: string): V | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.expiresAt < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: V, ttlMs?: number): void {
    this.store.set(key, { value, expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs) });
  }

  /** Delete any entry whose key starts with `prefix`. */
  invalidate(prefix: string): void {
    for (const k of this.store.keys()) {
      if (k.startsWith(prefix)) this.store.delete(k);
    }
  }

  clear(): void {
    this.store.clear();
  }
}

// ─── Ignore patterns + .mcpignore loader ─────────────────────

export const IGNORE_DIRS = [
  '.git',
  'node_modules',
  '__pycache__',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  'vendor',
  'target',
  'dist',
  'build',
  'out',
  'coverage',
  '.pytest_cache',
  '.tox',
];

export const IGNORE_FILES = [
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/bun.lock',
  '**/bun.lockb',
  '**/Cargo.lock',
  '**/poetry.lock',
  '**/composer.lock',
  '**/*.min.js',
  '**/*.min.css',
];

export const DEFAULT_IGNORE_PATTERNS = [
  ...IGNORE_DIRS.map((d) => `**/${d}/**`),
  ...IGNORE_FILES,
];

const ignoreCache = new TtlCache<string[]>(60_000);

/**
 * Reads `.mcpignore` at the repo root (optional). Each non-empty,
 * non-comment line is appended to the default fast-glob ignore set.
 * Lines without glob magic are wrapped as `** /<line>/**` to be friendly
 * to plain directory names (e.g. `bazel-bin`).
 */
export async function loadIgnorePatterns(repoRoot: string): Promise<string[]> {
  const cached = ignoreCache.get(repoRoot);
  if (cached) return cached;

  const file = path.join(repoRoot, '.mcpignore');
  let extra: string[] = [];
  try {
    if (await fs.pathExists(file)) {
      const raw = await fs.readFile(file, 'utf-8');
      extra = raw.split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('#'))
        .map((l) => /[*?[\]{}]/.test(l) ? l : `**/${l}/**`);
    }
  } catch {
    // best-effort
  }
  const out = extra.length > 0 ? [...DEFAULT_IGNORE_PATTERNS, ...extra] : DEFAULT_IGNORE_PATTERNS;
  ignoreCache.set(repoRoot, out);
  return out;
}

export function invalidateIgnore(repoRoot: string): void {
  ignoreCache.invalidate(repoRoot);
}

// ─── Binary detection ────────────────────────────────────────

export const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.tiff', '.svg',
  '.pdf', '.zip', '.tar', '.gz', '.tgz', '.7z', '.rar', '.bz2', '.xz',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.dmg', '.iso',
  '.mp3', '.mp4', '.wav', '.flac', '.ogg', '.webm', '.mov', '.avi', '.mkv',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.class', '.jar', '.war', '.pyc', '.pyo',
  '.lock', '.lockb',
  '.db', '.sqlite', '.sqlite3',
]);

const BINARY_SNIFF_BYTES = 4096;

export function isBinaryExtension(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export async function looksBinary(fullPath: string): Promise<boolean> {
  const fd = await fs.open(fullPath, 'r');
  try {
    const buf = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await fs.read(fd, buf, 0, BINARY_SNIFF_BYTES, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  } finally {
    await fs.close(fd);
  }
}

// ─── Repo path resolution ────────────────────────────────────

/**
 * Resolve a path inside a repo (or local folder) tracked in settings.
 * Guarantees the resolved absolute path stays under the repo root.
 *
 * @throws ToolError(REPO_NOT_FOUND) when the repo isn't tracked.
 * @throws ToolError(REPO_DIR_MISSING) when the directory was deleted.
 * @throws ToolError(PATH_TRAVERSAL) when subPath escapes the repo root.
 */
export async function resolveRepoPath(repoName: string, subPath: string = ''): Promise<string> {
  const config = await getConfig();
  if (!config.repos[repoName]) {
    throw new ToolError(
      'REPO_NOT_FOUND',
      `Repository "${repoName}" not found.`,
      `Call list_repos to see tracked repos, or add_repo / add_local_folder to register one.`,
    );
  }
  const repoRoot = repoRootPath(config.storagePath, repoName, config.repos[repoName].localPath);
  if (!(await fs.pathExists(repoRoot))) {
    throw new ToolError(
      'REPO_DIR_MISSING',
      `Repository directory missing on disk: ${repoName}`,
      `Run sync_repo "${repoName}" or remove_repo to clean up.`,
    );
  }
  const targetPath = path.resolve(repoRoot, subPath);
  const rel = path.relative(repoRoot, targetPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ToolError(
      'PATH_TRAVERSAL',
      `Security Error: Access denied to path outside repository: ${subPath}`,
    );
  }
  return targetPath;
}

/** Resolve just the repo root (for use by tools that need the bare folder). */
export function repoRootPath(storagePath: string, name: string, localPath?: string): string {
  if (localPath) {
    return path.isAbsolute(localPath) ? localPath : path.resolve(process.cwd(), localPath);
  }
  return path.resolve(process.cwd(), storagePath, name);
}

// ─── Format helpers ──────────────────────────────────────────

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function extensionsToGlob(extensions: string[]): string {
  const exts = extensions.map((e) => e.replace(/^\./, ''));
  if (exts.length === 0) return '**/*';
  if (exts.length === 1) return `**/*.${exts[0]}`;
  return `**/*.{${exts.join(',')}}`;
}

// ─── Output format types ─────────────────────────────────────

/**
 * Tools that accept `format: 'json'` should return JSON-stringified data.
 * AI clients parse this reliably and it's denser than prose.
 */
export type OutputFormat = 'text' | 'json';
