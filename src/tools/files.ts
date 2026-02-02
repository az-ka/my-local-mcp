import fs from 'fs-extra';
import path from 'path';
import glob from 'fast-glob';
import { getConfig } from '../config';

const MAX_FILE_SIZE = 50 * 1024; // 50KB

/**
 * Securely resolves a file path within a repository.
 * Throws an error if the path attempts to traverse outside the repo.
 */
async function resolveRepoPath(repoName: string, subPath: string = ''): Promise<string> {
  const config = await getConfig();
  
  // Normalize paths to handle cross-platform differences
  const storageRoot = path.resolve(process.cwd(), config.storagePath);
  const repoRoot = path.join(storageRoot, repoName);
  const targetPath = path.resolve(repoRoot, subPath);

  // Security check: Ensure targetPath is inside repoRoot
  if (!targetPath.startsWith(repoRoot)) {
    throw new Error(`Security Error: Access denied to path outside repository: ${subPath}`);
  }

  return targetPath;
}

/**
 * Lists files in a repository or subdirectory.
 * Ignores .git, node_modules, and other common garbage.
 */
export async function listFiles(repoName: string, subPath: string = '') {
  const targetPath = await resolveRepoPath(repoName, subPath);

  if (!(await fs.pathExists(targetPath))) {
    throw new Error(`Path does not exist: ${targetPath}`);
  }

  // If it's a file, return just that file
  const stat = await fs.stat(targetPath);
  if (stat.isFile()) {
    return [subPath];
  }

  // Use fast-glob to list files recursively
  const entries = await glob('**/*', {
    cwd: targetPath,
    dot: false, // Ignore dotfiles (like .git) by default
    ignore: ['**/node_modules/**', '**/.git/**', '**/package-lock.json', '**/*.lock'],
    onlyFiles: true,
  });

  return entries.map(e => path.join(subPath, e).replace(/\\/g, '/'));
}

/**
 * Reads the content of a specific file.
 * limits output to 50KB to prevent context overflow.
 */
export async function readFile(repoName: string, filePath: string) {
  const targetPath = await resolveRepoPath(repoName, filePath);

  if (!(await fs.pathExists(targetPath))) {
    throw new Error(`File not found: ${filePath}`);
  }

  const stat = await fs.stat(targetPath);
  if (!stat.isFile()) {
    throw new Error(`Path is not a file: ${filePath}`);
  }

  if (stat.size > MAX_FILE_SIZE) {
    // Read partial content
    const buffer = Buffer.alloc(MAX_FILE_SIZE);
    const fd = await fs.open(targetPath, 'r');
    await fs.read(fd, buffer, 0, MAX_FILE_SIZE, 0);
    await fs.close(fd);
    return `[WARNING: File too large (${stat.size} bytes). Truncated to first 50KB]\n\n${buffer.toString('utf-8')}`;
  }

  return fs.readFile(targetPath, 'utf-8');
}

/**
 * Simple text search (grep-like) across the repository.
 */
export async function searchCode(repoName: string, query: string) {
  const targetPath = await resolveRepoPath(repoName);
  
  if (!(await fs.pathExists(targetPath))) {
    throw new Error(`Repository not found: ${repoName}`);
  }

  const files = await listFiles(repoName);
  const results: string[] = [];
  const lowerQuery = query.toLowerCase();

  for (const file of files) {
    try {
      // Re-resolve per file to be safe/lazy
      const fullPath = await resolveRepoPath(repoName, file);
      
      // Skip large files for search optimization
      const stat = await fs.stat(fullPath);
      if (stat.size > MAX_FILE_SIZE) continue;

      const content = await fs.readFile(fullPath, 'utf-8');
      const lines = content.split('\n');

      lines.forEach((line, index) => {
        if (line.toLowerCase().includes(lowerQuery)) {
          results.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      });

      // Limit search results to avoid blowing up context
      if (results.length > 50) {
        results.push(`... (Search truncated, too many matches)`);
        break;
      }
    } catch (err) {
      // Ignore read errors (binary files etc)
      continue;
    }
  }

  if (results.length === 0) {
    return "No matches found.";
  }

  return results.join('\n');
}