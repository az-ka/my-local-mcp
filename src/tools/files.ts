import fs from 'fs-extra';
import path from 'path';
import glob from 'fast-glob';
import { getConfig } from '../config';

const MAX_FILE_SIZE = 50 * 1024; // 50KB
const BATCH_MAX_PER_FILE = 10 * 1024; // 10KB per file in batch mode
const DEFAULT_MAX_RESULTS = 50;

// Common ignore patterns
const IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/package-lock.json',
  '**/*.lock',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.svelte-kit/**',
  '**/vendor/**',
  '**/__pycache__/**',
  '**/.tox/**',
  '**/target/**',
];

// Documentation file extensions
const DOC_EXTENSIONS = ['.md', '.mdx', '.rst', '.txt', '.adoc', '.org'];
const DOC_FILENAMES = ['readme', 'changelog', 'contributing', 'license', 'authors', 'history', 'guide', 'tutorial', 'faq', 'api'];

/**
 * Securely resolves a file path within a repository.
 * Throws an error if the path attempts to traverse outside the repo.
 */
async function resolveRepoPath(repoName: string, subPath: string = ''): Promise<string> {
  const config = await getConfig();

  const storageRoot = path.resolve(process.cwd(), config.storagePath);
  const repoRoot = path.join(storageRoot, repoName);
  const targetPath = path.resolve(repoRoot, subPath);

  if (!targetPath.startsWith(repoRoot)) {
    throw new Error(`Security Error: Access denied to path outside repository: ${subPath}`);
  }

  return targetPath;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Build glob include pattern from extensions.
 * e.g. [".md", ".mdx"] → "**\/*.{md,mdx}"
 */
function extensionsToGlob(extensions: string[]): string {
  const exts = extensions.map(e => e.replace(/^\./, ''));
  if (exts.length === 1) return `**/*.${exts[0]}`;
  return `**/*.{${exts.join(',')}}`;
}

// ─── Enhanced Tools ──────────────────────────────────────────

/**
 * Lists files in a repository or subdirectory.
 * Supports extension filtering, size info, and depth control.
 */
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
    if (options.includeSize) {
      return [`${subPath} (${formatSize(stat.size)})`];
    }
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
    return entries.map(e => path.join(subPath, e).replace(/\\/g, '/'));
  }

  // With size info — batch stat calls
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

/**
 * Reads the content of a specific file.
 * Supports line range (start_line, end_line) for partial reads.
 */
export async function readFile(
  repoName: string,
  filePath: string,
  options: {
    startLine?: number;
    endLine?: number;
  } = {},
) {
  const targetPath = await resolveRepoPath(repoName, filePath);

  if (!(await fs.pathExists(targetPath))) {
    throw new Error(`File not found: ${filePath}`);
  }

  const stat = await fs.stat(targetPath);
  if (!stat.isFile()) {
    throw new Error(`Path is not a file: ${filePath}`);
  }

  const hasRange = options.startLine != null || options.endLine != null;

  // Full file read with size limit (no line range)
  if (!hasRange) {
    if (stat.size > MAX_FILE_SIZE) {
      const buffer = Buffer.alloc(MAX_FILE_SIZE);
      const fd = await fs.open(targetPath, 'r');
      await fs.read(fd, buffer, 0, MAX_FILE_SIZE, 0);
      await fs.close(fd);
      return `[WARNING: File too large (${formatSize(stat.size)}). Truncated to first 50KB]\n\n${buffer.toString('utf-8')}`;
    }
    return fs.readFile(targetPath, 'utf-8');
  }

  // Line range read
  const content = await fs.readFile(targetPath, 'utf-8');
  const lines = content.split('\n');
  const start = Math.max(1, options.startLine ?? 1);
  const end = Math.min(lines.length, options.endLine ?? lines.length);

  const selectedLines = lines.slice(start - 1, end);
  const header = `[Lines ${start}-${end} of ${lines.length} total]\n\n`;
  return header + selectedLines.map((line, i) => `${start + i}: ${line}`).join('\n');
}

/**
 * Enhanced text search across the repository.
 * Supports extension filter, context lines, max results, and path scoping.
 */
export async function searchCode(
  repoName: string,
  query: string,
  options: {
    extensions?: string[];
    contextLines?: number;
    maxResults?: number;
    path?: string;
  } = {},
) {
  const basePath = options.path || '';
  const targetPath = await resolveRepoPath(repoName, basePath);

  if (!(await fs.pathExists(targetPath))) {
    throw new Error(`Path not found: ${basePath || repoName}`);
  }

  const files = await listFiles(repoName, basePath, {
    extensions: options.extensions,
  });

  const results: string[] = [];
  const lowerQuery = query.toLowerCase();
  const contextLines = options.contextLines ?? 0;
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;

  for (const file of files) {
    try {
      const fullPath = await resolveRepoPath(repoName, file);
      const stat = await fs.stat(fullPath);
      if (stat.size > MAX_FILE_SIZE) continue;

      const content = await fs.readFile(fullPath, 'utf-8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (line.toLowerCase().includes(lowerQuery)) {
          if (contextLines > 0) {
            // With context: show surrounding lines
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

          if (results.length >= maxResults) {
            results.push(`\n[Search truncated at ${maxResults} results. Use 'path' or 'extensions' to narrow scope.]`);
            return results.join('\n');
          }
        }
      }
    } catch {
      continue;
    }
  }

  if (results.length === 0) {
    return 'No matches found.';
  }

  return results.join('\n');
}

// ─── New Tools ───────────────────────────────────────────────

/**
 * Get a visual directory tree of a repository.
 * Useful for understanding repo structure without listing every file.
 */
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

  async function walk(dir: string, prefix: string, depth: number) {
    if (depth > maxDepth) return;

    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }

    // Filter out ignored directories/files
    entries = entries.filter(e => {
      if (e === '.git' || e === 'node_modules' || e === '__pycache__' || e === '.next' || e === '.nuxt' || e === '.svelte-kit' || e === 'vendor' || e === 'target') return false;
      if (e.startsWith('.') && e !== '.github') return false;
      return true;
    });

    // Sort: directories first, then files
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

    // Apply extension filter to files
    let filteredFiles = fileEntries;
    if (options.extensions?.length) {
      filteredFiles = fileEntries.filter(f => {
        const ext = path.extname(f).toLowerCase();
        return options.extensions!.some(e => e.toLowerCase() === ext || `.${e.toLowerCase()}` === ext);
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

      if (isDir) {
        await walk(path.join(dir, entry), prefix + childPrefix, depth + 1);
      }
    }
  }

  await walk(targetPath, '', 1);

  if (lines.length === 1) {
    return `${rootLabel}/ (empty or all entries filtered)`;
  }

  return lines.join('\n');
}

/**
 * Smart documentation discovery.
 * Finds README, docs/, and documentation files with preview snippets.
 */
export async function findDocs(
  repoName: string,
  options: {
    topic?: string;
  } = {},
) {
  const repoPath = await resolveRepoPath(repoName);

  if (!(await fs.pathExists(repoPath))) {
    throw new Error(`Repository not found: ${repoName}`);
  }

  // 1. Find all documentation files
  const docGlob = extensionsToGlob(DOC_EXTENSIONS);
  const allDocFiles = await glob(docGlob, {
    cwd: repoPath,
    dot: false,
    ignore: IGNORE_PATTERNS,
    onlyFiles: true,
  });

  // 2. Score and sort by relevance
  type ScoredFile = { file: string; score: number; size: number };
  const scored: ScoredFile[] = [];

  for (const file of allDocFiles) {
    let score = 0;
    const lower = file.toLowerCase();
    const basename = path.basename(lower, path.extname(lower));

    // Boost known doc filenames
    if (DOC_FILENAMES.some(name => basename.includes(name))) score += 10;

    // Boost files in docs/ or documentation/ directories
    if (lower.startsWith('docs/') || lower.startsWith('documentation/') || lower.includes('/docs/')) score += 5;

    // Boost root-level files
    if (!file.includes('/') && !file.includes('\\')) score += 3;

    // Boost README specifically
    if (basename === 'readme') score += 20;

    // Topic matching
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

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // 3. Build output with previews for top files
  const topFiles = scored.slice(0, 30);
  const results: string[] = [];
  results.push(`Found ${scored.length} documentation files in "${repoName}".`);

  if (scored.length > 30) {
    results.push(`Showing top 30 most relevant.\n`);
  } else {
    results.push('');
  }

  // Show preview for top 5 files
  const previewCount = Math.min(5, topFiles.length);
  for (let i = 0; i < topFiles.length; i++) {
    const { file, size } = topFiles[i]!;

    if (i < previewCount) {
      // Show preview (first 5 lines)
      try {
        const fullPath = path.join(repoPath, file);
        const content = await fs.readFile(fullPath, 'utf-8');
        const previewLines = content.split('\n').slice(0, 5).map(l => `    ${l}`).join('\n');
        results.push(`📄 ${file} (${formatSize(size)})`);
        results.push(`${previewLines}`);
        results.push('');
      } catch {
        results.push(`📄 ${file} (${formatSize(size)})`);
      }
    } else {
      results.push(`  ${file} (${formatSize(size)})`);
    }
  }

  if (topFiles.length === 0) {
    return `No documentation files found in "${repoName}".`;
  }

  return results.join('\n');
}

/**
 * Read multiple files in a single call.
 * Each file is capped at a smaller limit (10KB) to prevent context overflow.
 */
export async function batchRead(
  repoName: string,
  paths: string[],
  options: {
    maxSizePerFile?: number;
  } = {},
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
        await fs.read(fd, buffer, 0, maxSize, 0);
        await fs.close(fd);
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
