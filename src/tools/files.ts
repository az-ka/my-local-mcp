import fs from 'fs-extra';
import path from 'path';
import glob from 'fast-glob';
import { getConfig } from '../config';

const MAX_FILE_SIZE = 200 * 1024; // 200KB default
const BATCH_MAX_PER_FILE = 10 * 1024;
const DEFAULT_MAX_RESULTS = 50;
const BINARY_SNIFF_BYTES = 4096;

// Single source of truth for ignore patterns.
const IGNORE_DIRS = [
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

const IGNORE_FILES = [
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

const IGNORE_PATTERNS = [
  ...IGNORE_DIRS.map((d) => `**/${d}/**`),
  ...IGNORE_FILES,
];

// Extensions known to be binary — skip when grepping.
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.tiff', '.svg',
  '.pdf', '.zip', '.tar', '.gz', '.tgz', '.7z', '.rar', '.bz2', '.xz',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.dmg', '.iso',
  '.mp3', '.mp4', '.wav', '.flac', '.ogg', '.webm', '.mov', '.avi', '.mkv',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.class', '.jar', '.war', '.pyc', '.pyo',
  '.lock', '.lockb',
  '.db', '.sqlite', '.sqlite3',
]);

const DOC_EXTENSIONS = ['.md', '.mdx', '.rst', '.txt', '.adoc', '.org'];
const DOC_FILENAMES = [
  'readme', 'changelog', 'contributing', 'license',
  'authors', 'history', 'guide', 'tutorial', 'faq', 'api',
];

async function resolveRepoPath(repoName: string, subPath: string = ''): Promise<string> {
  const config = await getConfig();
  const storageRoot = path.resolve(process.cwd(), config.storagePath);
  const repoRoot = path.join(storageRoot, repoName);
  const targetPath = path.resolve(repoRoot, subPath);

  // Make sure resolved path is inside repoRoot (with separator boundary).
  const rel = path.relative(repoRoot, targetPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Security Error: Access denied to path outside repository: ${subPath}`);
  }
  return targetPath;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function extensionsToGlob(extensions: string[]): string {
  const exts = extensions.map((e) => e.replace(/^\./, ''));
  if (exts.length === 1) return `**/*.${exts[0]}`;
  return `**/*.{${exts.join(',')}}`;
}

function isBinaryExtension(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * Read first chunk and return true if it looks binary (has null bytes).
 */
async function looksBinary(fullPath: string): Promise<boolean> {
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

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── listFiles ───────────────────────────────────────────────

export async function listFiles(
  repoName: string,
  subPath: string = '',
  options: {
    extensions?: string[];
    includeSize?: boolean;
    maxDepth?: number;
  } = {},
) {
  const targetPath = await resolveRepoPath(repoName, subPath);

  if (!(await fs.pathExists(targetPath))) {
    throw new Error(`Path does not exist: ${subPath || repoName}`);
  }

  const stat = await fs.stat(targetPath);
  if (stat.isFile()) {
    if (options.includeSize) return [`${subPath} (${formatSize(stat.size)})`];
    return [subPath];
  }

  const pattern = options.extensions?.length
    ? extensionsToGlob(options.extensions)
    : '**/*';

  const entries = await glob(pattern, {
    cwd: targetPath,
    dot: false,
    ignore: IGNORE_PATTERNS,
    onlyFiles: true,
    deep: options.maxDepth,
  });

  if (!options.includeSize) {
    return entries.map((e) => path.join(subPath, e).replace(/\\/g, '/'));
  }

  const results: string[] = [];
  for (const entry of entries) {
    try {
      const fullPath = path.join(targetPath, entry);
      const fileStat = await fs.stat(fullPath);
      const rel = path.join(subPath, entry).replace(/\\/g, '/');
      results.push(`${rel} (${formatSize(fileStat.size)})`);
    } catch {
      results.push(path.join(subPath, entry).replace(/\\/g, '/'));
    }
  }
  return results;
}

// ─── readFile ────────────────────────────────────────────────

export async function readFile(
  repoName: string,
  filePath: string,
  options: {
    startLine?: number;
    endLine?: number;
    maxSize?: number;
  } = {},
) {
  const targetPath = await resolveRepoPath(repoName, filePath);

  if (!(await fs.pathExists(targetPath))) {
    throw new Error(`File not found: ${filePath}`);
  }
  const stat = await fs.stat(targetPath);
  if (!stat.isFile()) throw new Error(`Path is not a file: ${filePath}`);

  const hasRange = options.startLine != null || options.endLine != null;
  const maxSize = options.maxSize ?? MAX_FILE_SIZE;

  if (!hasRange) {
    if (stat.size > maxSize) {
      const buffer = Buffer.alloc(maxSize);
      const fd = await fs.open(targetPath, 'r');
      try {
        await fs.read(fd, buffer, 0, maxSize, 0);
      } finally {
        await fs.close(fd);
      }
      return `[WARNING: File too large (${formatSize(stat.size)}). Truncated to ${formatSize(maxSize)}. Use start_line/end_line for ranged reads.]\n\n${buffer.toString('utf-8')}`;
    }
    return fs.readFile(targetPath, 'utf-8');
  }

  const content = await fs.readFile(targetPath, 'utf-8');
  const lines = content.split('\n');
  const total = lines.length;

  // Negative start_line counts from end (e.g. -50 = last 50 lines)
  let start: number;
  let end: number;
  if (options.startLine != null && options.startLine < 0) {
    start = Math.max(1, total + options.startLine + 1);
    end = options.endLine != null ? Math.min(total, options.endLine) : total;
  } else {
    start = Math.max(1, options.startLine ?? 1);
    end = Math.min(total, options.endLine ?? total);
  }

  if (start > end) {
    return `[Lines ${start}-${end} of ${total} total]\n\n(empty range)`;
  }

  const selectedLines = lines.slice(start - 1, end);
  const header = `[Lines ${start}-${end} of ${total} total]\n\n`;
  return header + selectedLines.map((line, i) => `${start + i}: ${line}`).join('\n');
}

// ─── searchCode ──────────────────────────────────────────────

export async function searchCode(
  repoName: string,
  query: string,
  options: {
    extensions?: string[];
    contextLines?: number;
    maxResults?: number;
    path?: string;
    caseSensitive?: boolean;
    regex?: boolean;
    wholeWord?: boolean;
  } = {},
) {
  const basePath = options.path || '';
  const targetPath = await resolveRepoPath(repoName, basePath);

  if (!(await fs.pathExists(targetPath))) {
    throw new Error(`Path not found: ${basePath || repoName}`);
  }

  const files = await listFiles(repoName, basePath, { extensions: options.extensions });

  // Build matcher
  const flags = options.caseSensitive ? '' : 'i';
  let pattern: RegExp;
  try {
    let src = options.regex ? query : escapeRegex(query);
    if (options.wholeWord) src = `\\b(?:${src})\\b`;
    pattern = new RegExp(src, flags);
  } catch (err: any) {
    throw new Error(`Invalid regex pattern: ${err.message}`);
  }

  const contextLines = options.contextLines ?? 0;
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const results: string[] = [];
  let matchCount = 0;

  for (const file of files) {
    if (isBinaryExtension(file)) continue;

    let fullPath: string;
    try {
      fullPath = await resolveRepoPath(repoName, file);
    } catch {
      continue;
    }

    let stat;
    try {
      stat = await fs.stat(fullPath);
    } catch {
      continue;
    }
    if (stat.size > MAX_FILE_SIZE * 10) continue; // skip huge files (>2MB)

    try {
      if (await looksBinary(fullPath)) continue;
    } catch {
      continue;
    }

    let content: string;
    try {
      content = await fs.readFile(fullPath, 'utf-8');
    } catch {
      continue;
    }

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      pattern.lastIndex = 0;
      if (!pattern.test(line)) continue;

      matchCount++;
      if (contextLines > 0) {
        const ctxStart = Math.max(0, i - contextLines);
        const ctxEnd = Math.min(lines.length - 1, i + contextLines);
        results.push(`--- ${file}:${i + 1} ---`);
        for (let j = ctxStart; j <= ctxEnd; j++) {
          const prefix = j === i ? '> ' : '  ';
          results.push(`${prefix}${j + 1}: ${lines[j] ?? ''}`);
        }
        results.push('');
      } else {
        results.push(`${file}:${i + 1}: ${line.trim()}`);
      }

      if (matchCount >= maxResults) {
        results.push(`\n[Search truncated at ${maxResults} results. Use 'path' or 'extensions' to narrow scope.]`);
        return results.join('\n');
      }
    }
  }

  if (results.length === 0) return 'No matches found.';
  return results.join('\n');
}

// ─── getTree ─────────────────────────────────────────────────

export async function getTree(
  repoName: string,
  options: {
    path?: string;
    maxDepth?: number;
    showFiles?: boolean;
    extensions?: string[];
  } = {},
) {
  const subPath = options.path || '';
  const targetPath = await resolveRepoPath(repoName, subPath);
  const maxDepth = options.maxDepth ?? 3;
  const showFiles = options.showFiles ?? true;

  if (!(await fs.pathExists(targetPath))) {
    throw new Error(`Path does not exist: ${subPath || repoName}`);
  }

  const lines: string[] = [];
  const rootLabel = subPath || repoName;
  lines.push(`${rootLabel}/`);

  const ignoreSet = new Set(IGNORE_DIRS);

  async function walk(dir: string, prefix: string, depth: number) {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }

    entries = entries.filter((e) => {
      if (ignoreSet.has(e)) return false;
      if (e.startsWith('.') && e !== '.github') return false;
      return true;
    });

    const dirEntries: string[] = [];
    const fileEntries: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      try {
        const stat = await fs.stat(fullPath);
        if (stat.isDirectory()) dirEntries.push(entry);
        else fileEntries.push(entry);
      } catch {
        fileEntries.push(entry);
      }
    }

    let filteredFiles = fileEntries;
    if (options.extensions?.length) {
      filteredFiles = fileEntries.filter((f) => {
        const ext = path.extname(f).toLowerCase();
        return options.extensions!.some(
          (e) => e.toLowerCase() === ext || `.${e.toLowerCase()}` === ext,
        );
      });
    }

    const sorted = [...dirEntries.sort(), ...(showFiles ? filteredFiles.sort() : [])];
    const total = sorted.length;
    for (let i = 0; i < total; i++) {
      const entry = sorted[i]!;
      const isLast = i === total - 1;
      const connector = isLast ? '└── ' : '├── ';
      const childPrefix = isLast ? '    ' : '│   ';
      const isDir = dirEntries.includes(entry);
      lines.push(`${prefix}${connector}${entry}${isDir ? '/' : ''}`);
      if (isDir) await walk(path.join(dir, entry), prefix + childPrefix, depth + 1);
    }
  }

  await walk(targetPath, '', 1);
  if (lines.length === 1) return `${rootLabel}/ (empty or all entries filtered)`;
  return lines.join('\n');
}

// ─── findDocs ────────────────────────────────────────────────

export async function findDocs(
  repoName: string,
  options: { topic?: string } = {},
) {
  const repoPath = await resolveRepoPath(repoName);
  if (!(await fs.pathExists(repoPath))) {
    throw new Error(`Repository not found: ${repoName}`);
  }

  const docGlob = extensionsToGlob(DOC_EXTENSIONS);
  const allDocFiles = await glob(docGlob, {
    cwd: repoPath,
    dot: false,
    ignore: IGNORE_PATTERNS,
    onlyFiles: true,
  });

  type ScoredFile = { file: string; score: number; size: number };
  const scored: ScoredFile[] = [];

  for (const file of allDocFiles) {
    let score = 0;
    const lower = file.toLowerCase();
    const basename = path.basename(lower, path.extname(lower));

    if (DOC_FILENAMES.some((name) => basename.includes(name))) score += 10;
    if (lower.startsWith('docs/') || lower.startsWith('documentation/') || lower.includes('/docs/')) score += 5;
    if (!file.includes('/') && !file.includes('\\')) score += 3;
    if (basename === 'readme') score += 20;
    if (options.topic) {
      const lowerTopic = options.topic.toLowerCase();
      if (lower.includes(lowerTopic)) score += 15;
    }

    try {
      const fullPath = path.join(repoPath, file);
      const stat = await fs.stat(fullPath);
      scored.push({ file: file.replace(/\\/g, '/'), score, size: stat.size });
    } catch {
      scored.push({ file: file.replace(/\\/g, '/'), score, size: 0 });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const topFiles = scored.slice(0, 30);

  const results: string[] = [];
  results.push(`Found ${scored.length} documentation files in "${repoName}".`);
  if (scored.length > 30) results.push(`Showing top 30 most relevant.\n`);
  else results.push('');

  const previewCount = Math.min(5, topFiles.length);
  for (let i = 0; i < topFiles.length; i++) {
    const { file, size } = topFiles[i]!;
    if (i < previewCount) {
      try {
        const fullPath = path.join(repoPath, file);
        const content = await fs.readFile(fullPath, 'utf-8');
        const previewLines = content.split('\n').slice(0, 5).map((l) => `    ${l}`).join('\n');
        results.push(`📄 ${file} (${formatSize(size)})`);
        results.push(previewLines);
        results.push('');
      } catch {
        results.push(`📄 ${file} (${formatSize(size)})`);
      }
    } else {
      results.push(`  ${file} (${formatSize(size)})`);
    }
  }

  if (topFiles.length === 0) return `No documentation files found in "${repoName}".`;
  return results.join('\n');
}

// ─── batchRead ───────────────────────────────────────────────

export async function batchRead(
  repoName: string,
  paths: string[],
  options: { maxSizePerFile?: number } = {},
) {
  const maxSize = options.maxSizePerFile ?? BATCH_MAX_PER_FILE;
  const results: string[] = [];

  for (const filePath of paths) {
    results.push(`\n${'='.repeat(60)}`);
    results.push(`📄 ${filePath}`);
    results.push('='.repeat(60));

    try {
      const targetPath = await resolveRepoPath(repoName, filePath);
      if (!(await fs.pathExists(targetPath))) {
        results.push('[ERROR: File not found]');
        continue;
      }
      const stat = await fs.stat(targetPath);
      if (!stat.isFile()) {
        results.push('[ERROR: Path is not a file]');
        continue;
      }

      if (stat.size > maxSize) {
        const buffer = Buffer.alloc(maxSize);
        const fd = await fs.open(targetPath, 'r');
        try {
          await fs.read(fd, buffer, 0, maxSize, 0);
        } finally {
          await fs.close(fd);
        }
        results.push(`[WARNING: Truncated from ${formatSize(stat.size)} to ${formatSize(maxSize)}]\n`);
        results.push(buffer.toString('utf-8'));
      } else {
        const content = await fs.readFile(targetPath, 'utf-8');
        results.push(content);
      }
    } catch (err: any) {
      results.push(`[ERROR: ${err.message}]`);
    }
  }
  return results.join('\n');
}

// ─── findFiles (NEW) ─────────────────────────────────────────

/**
 * Find files by glob pattern. e.g. "**\/*Config*.ts", "src/**\/*.py"
 */
export async function findFiles(
  repoName: string,
  pattern: string,
  options: {
    path?: string;
    maxResults?: number;
  } = {},
) {
  const basePath = options.path || '';
  const targetPath = await resolveRepoPath(repoName, basePath);

  if (!(await fs.pathExists(targetPath))) {
    throw new Error(`Path not found: ${basePath || repoName}`);
  }

  const max = options.maxResults ?? 200;
  const entries = await glob(pattern, {
    cwd: targetPath,
    dot: false,
    ignore: IGNORE_PATTERNS,
    onlyFiles: true,
    caseSensitiveMatch: false,
  });

  const truncated = entries.length > max;
  const sliced = entries.slice(0, max);
  const formatted = sliced.map((e) => path.join(basePath, e).replace(/\\/g, '/'));

  if (formatted.length === 0) return `No files matched pattern "${pattern}".`;
  let out = `Found ${entries.length} file(s) matching "${pattern}"`;
  if (truncated) out += ` (showing first ${max})`;
  return out + ':\n' + formatted.join('\n');
}

// ─── findSymbol (NEW) ────────────────────────────────────────

type SymbolKind = 'function' | 'class' | 'method' | 'interface' | 'type' | 'const' | 'any';

interface SymbolPattern {
  kind: SymbolKind;
  regex: (name: string) => RegExp;
  langs: string[];
}

const SYMBOL_PATTERNS: SymbolPattern[] = [
  // TypeScript / JavaScript
  { kind: 'function', langs: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    regex: (n) => new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${n}\\b`) },
  { kind: 'function', langs: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    regex: (n) => new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${n}\\s*[:=]\\s*(?:async\\s*)?(?:\\([^)]*\\)|[a-zA-Z_$<])`) },
  { kind: 'class', langs: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    regex: (n) => new RegExp(`^\\s*(?:export\\s+)?(?:abstract\\s+)?class\\s+${n}\\b`) },
  { kind: 'interface', langs: ['.ts', '.tsx'],
    regex: (n) => new RegExp(`^\\s*(?:export\\s+)?interface\\s+${n}\\b`) },
  { kind: 'type', langs: ['.ts', '.tsx'],
    regex: (n) => new RegExp(`^\\s*(?:export\\s+)?type\\s+${n}\\b`) },

  // Python
  { kind: 'function', langs: ['.py'],
    regex: (n) => new RegExp(`^\\s*(?:async\\s+)?def\\s+${n}\\s*\\(`) },
  { kind: 'class', langs: ['.py'],
    regex: (n) => new RegExp(`^\\s*class\\s+${n}\\b`) },

  // Go
  { kind: 'function', langs: ['.go'],
    regex: (n) => new RegExp(`^\\s*func\\s+(?:\\([^)]*\\)\\s+)?${n}\\s*\\(`) },
  { kind: 'type', langs: ['.go'],
    regex: (n) => new RegExp(`^\\s*type\\s+${n}\\b`) },

  // Rust
  { kind: 'function', langs: ['.rs'],
    regex: (n) => new RegExp(`^\\s*(?:pub\\s+)?(?:async\\s+)?fn\\s+${n}\\b`) },
  { kind: 'class', langs: ['.rs'],
    regex: (n) => new RegExp(`^\\s*(?:pub\\s+)?struct\\s+${n}\\b`) },

  // Java / Kotlin / C#
  { kind: 'class', langs: ['.java', '.kt', '.cs'],
    regex: (n) => new RegExp(`^\\s*(?:public|private|protected|internal|abstract|final|static|\\s)*\\s*class\\s+${n}\\b`) },
  { kind: 'interface', langs: ['.java', '.kt', '.cs'],
    regex: (n) => new RegExp(`^\\s*(?:public|private|protected|internal|\\s)*\\s*interface\\s+${n}\\b`) },

  // PHP
  { kind: 'function', langs: ['.php'],
    regex: (n) => new RegExp(`^\\s*(?:public|private|protected|static|\\s)*\\s*function\\s+${n}\\s*\\(`) },
  { kind: 'class', langs: ['.php'],
    regex: (n) => new RegExp(`^\\s*(?:abstract\\s+|final\\s+)?class\\s+${n}\\b`) },

  // Ruby
  { kind: 'function', langs: ['.rb'],
    regex: (n) => new RegExp(`^\\s*def\\s+(?:self\\.)?${n}\\b`) },
  { kind: 'class', langs: ['.rb'],
    regex: (n) => new RegExp(`^\\s*class\\s+${n}\\b`) },
];

/**
 * Find function/class/etc. definitions for a given symbol name across the repo.
 * Returns location + line for each match.
 */
export async function findSymbol(
  repoName: string,
  name: string,
  options: {
    kind?: SymbolKind;
    extensions?: string[];
    path?: string;
    maxResults?: number;
  } = {},
) {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
    throw new Error('Symbol name must be a valid identifier (letters, digits, _, $).');
  }

  const basePath = options.path || '';
  const targetPath = await resolveRepoPath(repoName, basePath);
  if (!(await fs.pathExists(targetPath))) {
    throw new Error(`Path not found: ${basePath || repoName}`);
  }

  // Use extensions filter if provided, else union of all known langs.
  const langExts = options.extensions?.length
    ? options.extensions.map((e) => e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`)
    : Array.from(new Set(SYMBOL_PATTERNS.flatMap((p) => p.langs)));

  const files = await listFiles(repoName, basePath, { extensions: langExts });

  type Hit = { file: string; line: number; kind: SymbolKind; preview: string };
  const hits: Hit[] = [];
  const max = options.maxResults ?? 50;

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    const applicable = SYMBOL_PATTERNS.filter((p) => {
      if (options.kind && options.kind !== 'any' && p.kind !== options.kind) return false;
      return p.langs.includes(ext);
    });
    if (applicable.length === 0) continue;

    let fullPath: string;
    try {
      fullPath = await resolveRepoPath(repoName, file);
    } catch {
      continue;
    }
    let content: string;
    try {
      const stat = await fs.stat(fullPath);
      if (stat.size > MAX_FILE_SIZE * 10) continue;
      content = await fs.readFile(fullPath, 'utf-8');
    } catch {
      continue;
    }

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      for (const p of applicable) {
        if (p.regex(name).test(line)) {
          hits.push({ file, line: i + 1, kind: p.kind, preview: line.trim() });
          break; // one kind per line is enough
        }
      }
      if (hits.length >= max) break;
    }
    if (hits.length >= max) break;
  }

  if (hits.length === 0) return `No definition found for symbol "${name}".`;

  // Group by kind for readability
  const out: string[] = [`Found ${hits.length} definition(s) for "${name}":\n`];
  for (const h of hits) {
    out.push(`[${h.kind}] ${h.file}:${h.line}`);
    out.push(`  ${h.preview}`);
  }
  return out.join('\n');
}

// ─── searchAllRepos (NEW) ────────────────────────────────────

export async function searchAllRepos(
  query: string,
  options: {
    extensions?: string[];
    maxResultsPerRepo?: number;
    caseSensitive?: boolean;
    regex?: boolean;
    wholeWord?: boolean;
  } = {},
) {
  const config = await getConfig();
  const repoNames = Object.keys(config.repos);
  if (repoNames.length === 0) return 'No repositories configured.';

  const perRepo = options.maxResultsPerRepo ?? 10;
  const out: string[] = [`Searching for "${query}" across ${repoNames.length} repos...\n`];

  for (const name of repoNames) {
    try {
      const result = await searchCode(name, query, {
        extensions: options.extensions,
        maxResults: perRepo,
        caseSensitive: options.caseSensitive,
        regex: options.regex,
        wholeWord: options.wholeWord,
      });
      if (result === 'No matches found.') continue;
      out.push(`\n━━━ ${name} ━━━`);
      out.push(result);
    } catch (err: any) {
      out.push(`\n━━━ ${name} (error: ${err.message}) ━━━`);
    }
  }

  if (out.length === 1) return out[0] + '\nNo matches in any repo.';
  return out.join('\n');
}
