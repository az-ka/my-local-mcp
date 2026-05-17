import fs from 'fs-extra';
import path from 'path';
import glob from 'fast-glob';
import { getConfig } from '../config';
import {
  ToolError,
  TtlCache,
  resolveRepoPath,
  repoRootPath,
  formatSize,
  escapeRegex,
  extensionsToGlob,
  loadIgnorePatterns,
  isBinaryExtension,
  looksBinary,
  IGNORE_DIRS,
  debug,
  timed,
  type OutputFormat,
} from '../shared';

const MAX_FILE_SIZE = 200 * 1024; // 200KB default
const BATCH_MAX_PER_FILE = 10 * 1024;
const DEFAULT_MAX_RESULTS = 50;

const DOC_EXTENSIONS = ['.md', '.mdx', '.rst', '.txt', '.adoc', '.org'];
const DOC_FILENAMES = [
  'readme', 'changelog', 'contributing', 'license',
  'authors', 'history', 'guide', 'tutorial', 'faq', 'api',
];

// ─── Cache ───────────────────────────────────────────────────

// Cache list/symbol scans for 30s; invalidated externally on sync/add/remove.
const listCache = new TtlCache<string[]>(30_000);
const symbolCache = new TtlCache<{ file: string; line: number; kind: string; scope?: string; preview: string }[]>(30_000);

function listCacheKey(repo: string, sub: string, ext?: string[], maxDepth?: number, ignoreSig?: string): string {
  return `list:${repo}|${sub}|${(ext || []).join(',')}|${maxDepth ?? ''}|${ignoreSig ?? ''}`;
}

export function invalidateRepoCaches(repoName: string): void {
  listCache.invalidate(`list:${repoName}|`);
  symbolCache.invalidate(`sym:${repoName}|`);
}

// ─── listFiles ───────────────────────────────────────────────

export interface ListFilesOptions {
  extensions?: string[];
  includeSize?: boolean;
  maxDepth?: number;
  /** Pagination: zero-based offset. */
  offset?: number;
  /** Pagination: max items to return. */
  limit?: number;
}

export interface ListFilesResult {
  items: string[];
  total: number;
  offset: number;
  hasMore: boolean;
}

/**
 * Returns a paginated list of files. The legacy `listFiles` wrapper preserves
 * the older array-of-strings contract; new callers should use
 * `listFilesPaged` for explicit pagination metadata.
 */
export async function listFilesPaged(
  repoName: string,
  subPath: string = '',
  options: ListFilesOptions = {},
): Promise<ListFilesResult> {
  const targetPath = await resolveRepoPath(repoName, subPath);

  if (!(await fs.pathExists(targetPath))) {
    throw new ToolError('PATH_NOT_FOUND', `Path does not exist: ${subPath || repoName}`);
  }

  const stat = await fs.stat(targetPath);
  if (stat.isFile()) {
    const item = options.includeSize ? `${subPath} (${formatSize(stat.size)})` : subPath;
    return { items: [item], total: 1, offset: 0, hasMore: false };
  }

  const config = await getConfig();
  const repoRoot = repoRootPath(config.storagePath, repoName, config.repos[repoName]?.localPath);
  const ignore = await loadIgnorePatterns(repoRoot);

  const cacheKey = listCacheKey(repoName, subPath, options.extensions, options.maxDepth, String(ignore.length));
  let entries = listCache.get(cacheKey);
  if (!entries) {
    entries = await timed(`listFiles ${repoName}/${subPath}`, () => glob(
      options.extensions?.length ? extensionsToGlob(options.extensions) : '**/*',
      {
        cwd: targetPath,
        dot: false,
        ignore,
        onlyFiles: true,
        deep: options.maxDepth,
      },
    ));
    listCache.set(cacheKey, entries);
  }

  const total = entries.length;
  const offset = Math.max(0, options.offset ?? 0);
  const limit = options.limit && options.limit > 0 ? options.limit : total;
  const sliced = entries.slice(offset, offset + limit);

  const items: string[] = [];
  if (options.includeSize) {
    for (const entry of sliced) {
      const rel = path.join(subPath, entry).replace(/\\/g, '/');
      try {
        const st = await fs.stat(path.join(targetPath, entry));
        items.push(`${rel} (${formatSize(st.size)})`);
      } catch {
        items.push(rel);
      }
    }
  } else {
    for (const entry of sliced) {
      items.push(path.join(subPath, entry).replace(/\\/g, '/'));
    }
  }

  return { items, total, offset, hasMore: offset + sliced.length < total };
}

/** Backward-compatible wrapper used by existing tests + tools. */
export async function listFiles(
  repoName: string,
  subPath: string = '',
  options: ListFilesOptions = {},
): Promise<string[]> {
  const r = await listFilesPaged(repoName, subPath, options);
  return r.items;
}

// ─── readFile ────────────────────────────────────────────────

export interface ReadFileOptions {
  startLine?: number;
  endLine?: number;
  maxSize?: number;
  /** When set, read a window centered on this line. Pair with `contextLines`. */
  aroundLine?: number;
  /** Window size around `aroundLine` (each side). Default 25. */
  contextLines?: number;
  /** When set, return the surrounding function/class/block by indentation/brace heuristics. */
  functionAtLine?: number;
}

/**
 * Reads a file with optional line range / window / function-extract modes.
 *
 * Modes (mutually exclusive — first present wins):
 *   1. functionAtLine: extract the enclosing brace/indent block.
 *   2. aroundLine + contextLines: window read centered on aroundLine.
 *   3. startLine/endLine: explicit 1-indexed range. Negative startLine
 *      counts from end (e.g. -50 = last 50 lines).
 *   4. Default: whole file, truncated to maxSize.
 */
export async function readFile(
  repoName: string,
  filePath: string,
  options: ReadFileOptions = {},
) {
  const targetPath = await resolveRepoPath(repoName, filePath);

  if (!(await fs.pathExists(targetPath))) {
    throw new ToolError('PATH_NOT_FOUND', `File not found: ${filePath}`);
  }
  const stat = await fs.stat(targetPath);
  if (!stat.isFile()) throw new ToolError('NOT_A_FILE', `Path is not a file: ${filePath}`);

  // Mode 1: enclosing function/block extraction
  if (options.functionAtLine != null) {
    const content = await fs.readFile(targetPath, 'utf-8');
    const lines = content.split('\n');
    const span = findEnclosingBlock(lines, options.functionAtLine);
    const total = lines.length;
    const selected = lines.slice(span.start - 1, span.end);
    const header = `[Enclosing block lines ${span.start}-${span.end} of ${total} total]\n\n`;
    return header + selected.map((line, i) => `${span.start + i}: ${line}`).join('\n');
  }

  // Mode 2: window around a line
  if (options.aroundLine != null) {
    const content = await fs.readFile(targetPath, 'utf-8');
    const lines = content.split('\n');
    const total = lines.length;
    const ctx = Math.max(0, options.contextLines ?? 25);
    const start = Math.max(1, options.aroundLine - ctx);
    const end = Math.min(total, options.aroundLine + ctx);
    const selected = lines.slice(start - 1, end);
    const header = `[Window lines ${start}-${end} of ${total} total — centered on ${options.aroundLine}]\n\n`;
    return header + selected.map((line, i) => `${start + i}: ${line}`).join('\n');
  }

  const hasRange = options.startLine != null || options.endLine != null;
  const maxSize = options.maxSize ?? MAX_FILE_SIZE;

  // Mode 4: whole file
  if (!hasRange) {
    if (stat.size > maxSize) {
      const buffer = Buffer.alloc(maxSize);
      const fd = await fs.open(targetPath, 'r');
      try {
        await fs.read(fd, buffer, 0, maxSize, 0);
      } finally {
        await fs.close(fd);
      }
      return `[WARNING: File too large (${formatSize(stat.size)}). Truncated to ${formatSize(maxSize)}. Use start_line/end_line or around_line for ranged reads.]\n\n${buffer.toString('utf-8')}`;
    }
    return fs.readFile(targetPath, 'utf-8');
  }

  // Mode 3: explicit range
  const content = await fs.readFile(targetPath, 'utf-8');
  const lines = content.split('\n');
  const total = lines.length;

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

/**
 * Heuristic enclosing-block detector. Walks upward from `line` looking for
 * an open brace or a "signature-ish" decreasing-indentation line. Then walks
 * forward to either the matching brace or the next sibling-or-shallower line.
 *
 * Works well for C-family + Python-style code. NOT a replacement for tree-sitter
 * but adequate for AI reading a function around a search hit.
 */
function findEnclosingBlock(lines: string[], line: number): { start: number; end: number } {
  const total = lines.length;
  if (total === 0) return { start: 1, end: 0 };
  const idx = Math.max(0, Math.min(total - 1, line - 1));

  const indentOf = (s: string): number => {
    let i = 0;
    while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
    return s.slice(0, i).replace(/\t/g, '    ').length;
  };

  // Walk upward to find a candidate start
  let startIdx = idx;
  let braceCount = 0;
  for (let i = idx; i >= 0; i--) {
    const raw = lines[i]!;
    // Count braces while scanning up
    for (const ch of raw) {
      if (ch === '}') braceCount++;
      else if (ch === '{') {
        if (braceCount > 0) braceCount--;
        else { startIdx = i; i = -1; break; }
      }
    }
    if (i === -1) break;
    // Or: a likely signature line (def/function/class/fn/etc) at low indent
    if (/^\s*(?:export\s+)?(?:async\s+)?(?:public|private|protected|static|abstract|final|\s)*\s*(?:function|class|interface|type|def|fn|func|struct|enum|trait|impl)\b/.test(raw)) {
      startIdx = i;
      break;
    }
  }

  // Walk downward to find matching close or next shallower line
  const baseIndent = indentOf(lines[startIdx]!);
  let endIdx = startIdx;
  let openCount = 0;
  let sawOpen = false;
  for (let i = startIdx; i < total; i++) {
    const raw = lines[i]!;
    for (const ch of raw) {
      if (ch === '{') { openCount++; sawOpen = true; }
      else if (ch === '}') openCount--;
    }
    endIdx = i;
    if (sawOpen && openCount <= 0 && i > startIdx) break;
    if (!sawOpen && i > startIdx && raw.trim().length > 0 && indentOf(raw) <= baseIndent && !/^[)\]}\s]/.test(raw)) {
      // Python-style: next line at same or shallower indent ends block.
      endIdx = i - 1;
      break;
    }
  }

  return { start: startIdx + 1, end: endIdx + 1 };
}

// ─── searchCode ──────────────────────────────────────────────

export interface SearchCodeOptions {
  extensions?: string[];
  contextLines?: number;
  maxResults?: number;
  path?: string;
  caseSensitive?: boolean;
  regex?: boolean;
  wholeWord?: boolean;
  /** Group results by file (file-then-matches) instead of flat list. */
  group?: boolean;
  format?: OutputFormat;
}

interface SearchHit {
  file: string;
  line: number;
  text: string;
  context?: { line: number; text: string; isMatch: boolean }[];
}

export async function searchCode(
  repoName: string,
  query: string,
  options: SearchCodeOptions = {},
) {
  const basePath = options.path || '';
  const targetPath = await resolveRepoPath(repoName, basePath);

  if (!(await fs.pathExists(targetPath))) {
    throw new ToolError('PATH_NOT_FOUND', `Path not found: ${basePath || repoName}`);
  }

  const files = await listFiles(repoName, basePath, { extensions: options.extensions });

  const flags = options.caseSensitive ? '' : 'i';
  let pattern: RegExp;
  try {
    let src = options.regex ? query : escapeRegex(query);
    if (options.wholeWord) src = `\\b(?:${src})\\b`;
    pattern = new RegExp(src, flags);
  } catch (err: any) {
    throw new ToolError('INVALID_REGEX', `Invalid regex pattern: ${err.message}`);
  }

  const contextLines = options.contextLines ?? 0;
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;

  const hits: SearchHit[] = [];
  let truncated = false;

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
    if (stat.size > MAX_FILE_SIZE * 10) continue;

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

      const hit: SearchHit = { file, line: i + 1, text: line.trim() };
      if (contextLines > 0) {
        const ctxStart = Math.max(0, i - contextLines);
        const ctxEnd = Math.min(lines.length - 1, i + contextLines);
        hit.context = [];
        for (let j = ctxStart; j <= ctxEnd; j++) {
          hit.context.push({ line: j + 1, text: lines[j] ?? '', isMatch: j === i });
        }
      }
      hits.push(hit);

      if (hits.length >= maxResults) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }

  if (options.format === 'json') {
    return JSON.stringify({
      query, total: hits.length, truncated, hits,
    }, null, 2);
  }

  if (hits.length === 0) return 'No matches found.';

  const out: string[] = [];
  if (options.group) {
    const byFile = new Map<string, SearchHit[]>();
    for (const h of hits) {
      if (!byFile.has(h.file)) byFile.set(h.file, []);
      byFile.get(h.file)!.push(h);
    }
    for (const [file, group] of byFile) {
      out.push(`── ${file} (${group.length}) ──`);
      for (const h of group) {
        if (h.context) {
          out.push(`  L${h.line}:`);
          for (const c of h.context) {
            const prefix = c.isMatch ? '  > ' : '    ';
            out.push(`${prefix}${c.line}: ${c.text}`);
          }
        } else {
          out.push(`  ${h.line}: ${h.text}`);
        }
      }
      out.push('');
    }
  } else {
    for (const h of hits) {
      if (h.context) {
        out.push(`--- ${h.file}:${h.line} ---`);
        for (const c of h.context) {
          const prefix = c.isMatch ? '> ' : '  ';
          out.push(`${prefix}${c.line}: ${c.text}`);
        }
        out.push('');
      } else {
        out.push(`${h.file}:${h.line}: ${h.text}`);
      }
    }
  }
  if (truncated) {
    out.push(`\n[Search truncated at ${maxResults} results. Use 'path' or 'extensions' to narrow scope.]`);
  }
  return out.join('\n');
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
    throw new ToolError('PATH_NOT_FOUND', `Path does not exist: ${subPath || repoName}`);
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
    throw new ToolError('REPO_DIR_MISSING', `Repository not found: ${repoName}`);
  }

  const config = await getConfig();
  const ignore = await loadIgnorePatterns(
    repoRootPath(config.storagePath, repoName, config.repos[repoName]?.localPath),
  );

  const docGlob = extensionsToGlob(DOC_EXTENSIONS);
  const allDocFiles = await glob(docGlob, {
    cwd: repoPath,
    dot: false,
    ignore,
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

// ─── findFiles ───────────────────────────────────────────────

export interface FindFilesOptions {
  path?: string;
  maxResults?: number;
  offset?: number;
}

export async function findFiles(
  repoName: string,
  pattern: string,
  options: FindFilesOptions = {},
) {
  const basePath = options.path || '';
  const targetPath = await resolveRepoPath(repoName, basePath);

  if (!(await fs.pathExists(targetPath))) {
    throw new ToolError('PATH_NOT_FOUND', `Path not found: ${basePath || repoName}`);
  }

  const config = await getConfig();
  const ignore = await loadIgnorePatterns(
    repoRootPath(config.storagePath, repoName, config.repos[repoName]?.localPath),
  );

  const entries = await glob(pattern, {
    cwd: targetPath,
    dot: false,
    ignore,
    onlyFiles: true,
    caseSensitiveMatch: false,
  });

  const offset = Math.max(0, options.offset ?? 0);
  const max = options.maxResults ?? 200;
  const sliced = entries.slice(offset, offset + max);
  const formatted = sliced.map((e) => path.join(basePath, e).replace(/\\/g, '/'));

  if (entries.length === 0) return `No files matched pattern "${pattern}".`;
  if (formatted.length === 0) return `No files in range (offset=${offset}); total ${entries.length}.`;

  let out = `Found ${entries.length} file(s) matching "${pattern}"`;
  if (offset > 0) out += ` (skip ${offset})`;
  if (offset + sliced.length < entries.length) {
    out += ` (showing ${formatted.length}; ${entries.length - offset - sliced.length} more — use offset=${offset + sliced.length})`;
  }
  return out + ':\n' + formatted.join('\n');
}

// ─── Symbol patterns ─────────────────────────────────────────

export type SymbolKind =
  | 'function' | 'method'
  | 'class' | 'interface' | 'trait'
  | 'type' | 'enum' | 'struct' | 'impl'
  | 'const' | 'any';

interface SymbolPattern {
  kind: SymbolKind;
  regex: (name: string) => RegExp;
  langs: string[];
}

const SYMBOL_PATTERNS: SymbolPattern[] = [
  // ─ TypeScript / JavaScript ─────────────────────────────
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
  { kind: 'enum', langs: ['.ts', '.tsx'],
    regex: (n) => new RegExp(`^\\s*(?:export\\s+)?(?:const\\s+)?enum\\s+${n}\\b`) },

  // ─ Python ──────────────────────────────────────────────
  { kind: 'function', langs: ['.py'],
    regex: (n) => new RegExp(`^\\s*(?:async\\s+)?def\\s+${n}\\s*\\(`) },
  { kind: 'class', langs: ['.py'],
    regex: (n) => new RegExp(`^\\s*class\\s+${n}\\b`) },

  // ─ Go ──────────────────────────────────────────────────
  { kind: 'function', langs: ['.go'],
    regex: (n) => new RegExp(`^\\s*func\\s+(?:\\([^)]*\\)\\s+)?${n}\\s*\\(`) },
  { kind: 'type', langs: ['.go'],
    regex: (n) => new RegExp(`^\\s*type\\s+${n}\\b`) },
  { kind: 'struct', langs: ['.go'],
    regex: (n) => new RegExp(`^\\s*type\\s+${n}\\s+struct\\b`) },

  // ─ Rust ────────────────────────────────────────────────
  { kind: 'function', langs: ['.rs'],
    regex: (n) => new RegExp(`^\\s*(?:pub(?:\\([^)]+\\))?\\s+)?(?:async\\s+)?(?:const\\s+)?(?:unsafe\\s+)?fn\\s+${n}\\b`) },
  { kind: 'struct', langs: ['.rs'],
    regex: (n) => new RegExp(`^\\s*(?:pub(?:\\([^)]+\\))?\\s+)?struct\\s+${n}\\b`) },
  { kind: 'enum', langs: ['.rs'],
    regex: (n) => new RegExp(`^\\s*(?:pub(?:\\([^)]+\\))?\\s+)?enum\\s+${n}\\b`) },
  { kind: 'trait', langs: ['.rs'],
    regex: (n) => new RegExp(`^\\s*(?:pub(?:\\([^)]+\\))?\\s+)?trait\\s+${n}\\b`) },
  { kind: 'impl', langs: ['.rs'],
    regex: (n) => new RegExp(`^\\s*impl(?:<[^>]*>)?\\s+(?:[^\\s{]+\\s+for\\s+)?${n}\\b`) },

  // ─ Java / Kotlin / C# ──────────────────────────────────
  { kind: 'class', langs: ['.java', '.kt', '.cs'],
    regex: (n) => new RegExp(`^\\s*(?:public|private|protected|internal|abstract|final|static|sealed|open|data|\\s)*\\s*class\\s+${n}\\b`) },
  { kind: 'interface', langs: ['.java', '.kt', '.cs'],
    regex: (n) => new RegExp(`^\\s*(?:public|private|protected|internal|\\s)*\\s*interface\\s+${n}\\b`) },
  { kind: 'enum', langs: ['.java', '.kt', '.cs'],
    regex: (n) => new RegExp(`^\\s*(?:public|private|protected|internal|\\s)*\\s*enum\\s+(?:class\\s+)?${n}\\b`) },

  // ─ PHP ─────────────────────────────────────────────────
  { kind: 'function', langs: ['.php'],
    regex: (n) => new RegExp(`^\\s*(?:public|private|protected|static|\\s)*\\s*function\\s+${n}\\s*\\(`) },
  { kind: 'class', langs: ['.php'],
    regex: (n) => new RegExp(`^\\s*(?:abstract\\s+|final\\s+)?class\\s+${n}\\b`) },

  // ─ Ruby ────────────────────────────────────────────────
  { kind: 'function', langs: ['.rb'],
    regex: (n) => new RegExp(`^\\s*def\\s+(?:self\\.)?${n}\\b`) },
  { kind: 'class', langs: ['.rb'],
    regex: (n) => new RegExp(`^\\s*class\\s+${n}\\b`) },

  // ─ Swift ───────────────────────────────────────────────
  { kind: 'function', langs: ['.swift'],
    regex: (n) => new RegExp(`^\\s*(?:public|private|internal|fileprivate|open|static|class|\\s)*\\s*func\\s+${n}\\s*[\\(<]`) },
  { kind: 'class', langs: ['.swift'],
    regex: (n) => new RegExp(`^\\s*(?:public|private|internal|fileprivate|open|final|\\s)*\\s*class\\s+${n}\\b`) },
  { kind: 'struct', langs: ['.swift'],
    regex: (n) => new RegExp(`^\\s*(?:public|private|internal|fileprivate|\\s)*\\s*struct\\s+${n}\\b`) },
];

const validIdentifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// ─── findSymbol ──────────────────────────────────────────────

export interface FindSymbolOptions {
  kind?: SymbolKind;
  extensions?: string[];
  path?: string;
  maxResults?: number;
  offset?: number;
  format?: OutputFormat;
}

interface SymbolHit {
  file: string;
  line: number;
  kind: SymbolKind;
  scope?: string;
  preview: string;
}

/**
 * Locate definitions for a symbol name across the repo. Uses language-aware
 * regex patterns; returns kind + scope (enclosing class/module/namespace when
 * detectable).
 */
export async function findSymbol(
  repoName: string,
  name: string,
  options: FindSymbolOptions = {},
) {
  if (!validIdentifier.test(name)) {
    throw new ToolError('INVALID_INPUT',
      'Symbol name must be a valid identifier (letters, digits, _, $).');
  }

  const basePath = options.path || '';
  const targetPath = await resolveRepoPath(repoName, basePath);
  if (!(await fs.pathExists(targetPath))) {
    throw new ToolError('PATH_NOT_FOUND', `Path not found: ${basePath || repoName}`);
  }

  const langExts = options.extensions?.length
    ? options.extensions.map((e) => e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`)
    : Array.from(new Set(SYMBOL_PATTERNS.flatMap((p) => p.langs)));

  // Cache scan results
  const cacheKey = `sym:${repoName}|${basePath}|${name}|${(options.kind ?? '')}|${langExts.join(',')}`;
  let allHits = symbolCache.get(cacheKey);
  if (!allHits) {
    allHits = await scanSymbol(repoName, basePath, name, langExts, options.kind);
    symbolCache.set(cacheKey, allHits);
  }

  const offset = Math.max(0, options.offset ?? 0);
  const max = options.maxResults ?? 50;
  const sliced = allHits.slice(offset, offset + max);

  if (options.format === 'json') {
    return JSON.stringify({
      name,
      total: allHits.length,
      offset,
      hasMore: offset + sliced.length < allHits.length,
      hits: sliced,
    }, null, 2);
  }

  if (allHits.length === 0) return `No definition found for symbol "${name}".`;
  if (sliced.length === 0) return `No definitions in range (offset=${offset}); total ${allHits.length}.`;

  const out: string[] = [`Found ${allHits.length} definition(s) for "${name}":\n`];
  for (const h of sliced) {
    const scope = h.scope ? ` in ${h.scope}` : '';
    out.push(`[${h.kind}${scope}] ${h.file}:${h.line}`);
    out.push(`  ${h.preview}`);
  }
  if (offset + sliced.length < allHits.length) {
    out.push(`\n[Showing ${sliced.length} of ${allHits.length}. Use offset=${offset + sliced.length} for next page.]`);
  }
  return out.join('\n');
}

async function scanSymbol(
  repoName: string,
  basePath: string,
  name: string,
  langExts: string[],
  kindFilter: SymbolKind | undefined,
): Promise<SymbolHit[]> {
  const files = await listFiles(repoName, basePath, { extensions: langExts });
  const hits: SymbolHit[] = [];

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    const applicable = SYMBOL_PATTERNS.filter((p) => {
      if (kindFilter && kindFilter !== 'any' && p.kind !== kindFilter) return false;
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
    // Stack-based scope tracker: pushes class/module/namespace headers we cross.
    const scopeStack: { name: string; indent: number; closeOnDedent: boolean }[] = [];
    const indentOf = (s: string): number => {
      let i = 0;
      while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
      return s.slice(0, i).replace(/\t/g, '    ').length;
    };
    const isContainerLine = (l: string): { name: string; closeOnDedent: boolean } | null => {
      const c = l.match(/^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/)
        || l.match(/^\s*(?:export\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)/)
        || l.match(/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:class|interface)\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
      if (c && c[1]) return { name: c[1], closeOnDedent: false };
      const py = l.match(/^\s*class\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
      if (py && py[1]) return { name: py[1], closeOnDedent: true };
      const ns = l.match(/^\s*(?:export\s+)?(?:namespace|module)\s+([A-Za-z_$][A-Za-z0-9_$.]*)/);
      if (ns && ns[1]) return { name: ns[1], closeOnDedent: false };
      const pkg = l.match(/^\s*package\s+([A-Za-z_$][A-Za-z0-9_$.]*)/);
      if (pkg && pkg[1] && ext === '.go') return { name: pkg[1], closeOnDedent: false };
      return null;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      const indent = indentOf(line);

      // Pop scopes whose indent we've dedented past (python-style).
      while (scopeStack.length > 0) {
        const top = scopeStack[scopeStack.length - 1]!;
        if (top.closeOnDedent && line.trim().length > 0 && indent <= top.indent) {
          scopeStack.pop();
        } else break;
      }

      const container = isContainerLine(line);
      if (container) {
        scopeStack.push({ name: container.name, indent, closeOnDedent: container.closeOnDedent });
      }

      for (const p of applicable) {
        if (p.regex(name).test(line)) {
          const scope = scopeStack.length > 0 ? scopeStack.map((s) => s.name).join('.') : undefined;
          hits.push({ file, line: i + 1, kind: p.kind, scope, preview: line.trim() });
          break;
        }
      }
    }
  }
  return hits;
}

// ─── findReferences ──────────────────────────────────────────

export interface FindReferencesOptions {
  extensions?: string[];
  path?: string;
  maxResults?: number;
  offset?: number;
  /** When true, drop hits that are inside line/block comments or string literals (heuristic). */
  excludeCommentsAndStrings?: boolean;
  /** Exclude definitions (returns only callers/usages). */
  excludeDefinitions?: boolean;
  format?: OutputFormat;
}

const DEF_LINE_REGEX = /\b(?:function|class|interface|type|enum|struct|trait|impl|def|func|fn|namespace|module|package)\b/;

/**
 * Find every reference to an identifier across the repo. Word-boundary search
 * with optional comment/string stripping. Use this when `find_symbol` already
 * answered "where defined?" and you need "where used?".
 */
export async function findReferences(
  repoName: string,
  name: string,
  options: FindReferencesOptions = {},
) {
  if (!validIdentifier.test(name)) {
    throw new ToolError('INVALID_INPUT',
      'Reference name must be a valid identifier (letters, digits, _, $).');
  }
  const basePath = options.path || '';
  const targetPath = await resolveRepoPath(repoName, basePath);
  if (!(await fs.pathExists(targetPath))) {
    throw new ToolError('PATH_NOT_FOUND', `Path not found: ${basePath || repoName}`);
  }

  const langExts = options.extensions?.length
    ? options.extensions.map((e) => e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`)
    : undefined;

  const files = await listFiles(repoName, basePath, langExts ? { extensions: langExts } : {});
  const pattern = new RegExp(`\\b${escapeRegex(name)}\\b`);

  interface RefHit { file: string; line: number; text: string; isDefinition: boolean; }
  const hits: RefHit[] = [];
  const max = options.maxResults ?? 100;
  const offset = Math.max(0, options.offset ?? 0);
  // We need to compute total to support pagination semantics; cap scan at offset+max+1 for hasMore detection.
  const scanCap = offset + max + 1;
  let scanned = 0;

  for (const file of files) {
    if (isBinaryExtension(file)) continue;
    let full: string;
    try { full = await resolveRepoPath(repoName, file); } catch { continue; }
    let content: string;
    try {
      const stat = await fs.stat(full);
      if (stat.size > MAX_FILE_SIZE * 10) continue;
      if (await looksBinary(full)) continue;
      content = await fs.readFile(full, 'utf-8');
    } catch {
      continue;
    }
    const stripped = options.excludeCommentsAndStrings ? stripCommentsAndStrings(content, path.extname(file)) : content;
    const lines = stripped.split('\n');
    const origLines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const stripLine = lines[i] ?? '';
      if (!pattern.test(stripLine)) continue;
      const origLine = origLines[i] ?? stripLine;
      const isDef = DEF_LINE_REGEX.test(origLine) && new RegExp(`\\b(?:function|class|interface|type|enum|struct|trait|impl|def|func|fn)\\s+${escapeRegex(name)}\\b`).test(origLine);
      if (options.excludeDefinitions && isDef) continue;
      hits.push({ file, line: i + 1, text: origLine.trim(), isDefinition: isDef });
      scanned++;
      if (scanned >= scanCap) break;
    }
    if (scanned >= scanCap) break;
  }

  const sliced = hits.slice(offset, offset + max);

  if (options.format === 'json') {
    return JSON.stringify({
      name,
      total: hits.length,
      offset,
      hasMore: hits.length > offset + sliced.length,
      hits: sliced,
    }, null, 2);
  }

  if (hits.length === 0) return `No references found for "${name}".`;
  if (sliced.length === 0) return `No references in range (offset=${offset}); total scanned ${hits.length}.`;

  const out: string[] = [`Found ${hits.length}${hits.length >= scanCap ? '+' : ''} reference(s) to "${name}":\n`];
  for (const h of sliced) {
    const marker = h.isDefinition ? ' [def]' : '';
    out.push(`${h.file}:${h.line}${marker}: ${h.text}`);
  }
  if (hits.length > offset + sliced.length) {
    out.push(`\n[Showing ${sliced.length} of ${hits.length}${hits.length >= scanCap ? '+' : ''}. Use offset=${offset + sliced.length} for next page.]`);
  }
  return out.join('\n');
}

/**
 * Heuristically strip line comments, block comments, and string/char literals,
 * replacing their contents with spaces so line numbers stay aligned.
 * Not a full lexer — good enough to avoid false positives in references.
 */
function stripCommentsAndStrings(src: string, ext: string): string {
  const cstyle = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.java', '.kt', '.cs', '.go', '.rs', '.php', '.swift', '.c', '.cc', '.cpp', '.h', '.hpp']);
  const pystyle = new Set(['.py']);
  const useC = cstyle.has(ext);
  const usePy = pystyle.has(ext);

  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i]!;
    const next = i + 1 < n ? src[i + 1] : '';

    // C-style line comment
    if (useC && ch === '/' && next === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    // C-style block comment
    if (useC && ch === '/' && next === '*') {
      out += '  '; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += '  '; i += 2;
      continue;
    }
    // Shell/python/ruby line comment
    if ((usePy || ext === '.rb' || ext === '.sh') && ch === '#') {
      while (i < n && src[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    // Strings
    if (ch === '"' || ch === '\'' || (useC && ch === '`')) {
      const quote = ch;
      out += quote; i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < n) {
          out += src[i] === '\n' ? '\n' : ' ';
          i++;
          out += src[i] === '\n' ? '\n' : ' ';
          i++;
          continue;
        }
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) { out += quote; i++; }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// ─── searchAllRepos ──────────────────────────────────────────

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
