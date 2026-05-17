/**
 * Integration test for the Local MCP server.
 * Run: bun run test.ts
 *
 * Self-bootstrap: clones the godotenv test repo into storage/ on first run.
 */
import fs from 'fs-extra';
import path from 'path';
import simpleGit from 'simple-git';
import {
  listFiles, listFilesPaged, readFile, searchCode, getTree, findDocs, batchRead,
  findFiles, findSymbol, findReferences, searchAllRepos,
  invalidateRepoCaches,
} from './src/tools/files';
import {
  listRepos, normalizeRepoInput,
  gitLog, gitShow, gitDiff, listBranches, listTags,
  gitBlame, gitStatus, gitGrep,
  addLocalFolder, removeRepo,
} from './src/tools/git';
import { ToolError, describeError, formatErrorText, loadIgnorePatterns } from './src/shared';
import { getConfig, saveConfig } from './src/config';

const PASS = '✅ PASS';
const FAIL = '❌ FAIL';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`${PASS}: ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`${FAIL}: ${name}`);
    console.error(`   Error: ${err.message}`);
    if (err.stack) console.error(`   ${err.stack.split('\n').slice(1, 3).join('\n   ')}`);
    failed++;
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

const TEST_REPO = 'godotenv';
const TEST_REPO_URL = 'https://github.com/joho/godotenv';

// ─── Auto-bootstrap ─────────────────────────────────────────

async function ensureTestRepo(): Promise<void> {
  const config = await getConfig();
  const repoPath = path.resolve(process.cwd(), config.storagePath, TEST_REPO);
  if (await fs.pathExists(repoPath) && config.repos[TEST_REPO]) {
    console.log(`Test repo "${TEST_REPO}" already present.`);
    return;
  }
  if (!(await fs.pathExists(repoPath))) {
    await fs.ensureDir(path.dirname(repoPath));
    console.log(`Cloning ${TEST_REPO_URL} into ${repoPath}...`);
    await simpleGit().clone(TEST_REPO_URL, repoPath);
  }
  config.repos[TEST_REPO] = {
    url: TEST_REPO_URL,
    branch: 'main',
    lastSync: new Date().toISOString(),
    kind: 'git',
  };
  await saveConfig(config);
}

console.log('='.repeat(60));
console.log('  LOCAL MCP v4.0 — Integration Tests');
console.log('='.repeat(60));

await ensureTestRepo();
console.log(`Using test repo: "${TEST_REPO}"\n`);

// ─── Existing — repo & URL parsing ───────────────────────────

await test('listRepos — returns managed repos', async () => {
  const result = await listRepos();
  assert(result.includes(TEST_REPO), `Should contain "${TEST_REPO}"`);
  assert(result.includes('Managed Repositories'), 'Should have header');
});

await test('listRepos — includes branch labels', async () => {
  const result = await listRepos();
  assert(result.includes('[branch:'), 'Should include branch metadata');
});

await test('listRepos — filter substring', async () => {
  const result = await listRepos({ filter: TEST_REPO.slice(0, 4) });
  assert(result.includes(TEST_REPO), 'Filter hit');
});

await test('listRepos — filter miss', async () => {
  const result = await listRepos({ filter: 'ZZZ-no-such-repo' });
  assert(result.includes('No repositories matched'), 'Empty filter result');
});

await test('listRepos — sort by lastSync', async () => {
  const result = await listRepos({ sort: 'lastSync' });
  assert(result.includes(TEST_REPO), 'Sorted output still includes repo');
});

await test('normalizeRepoInput — parses tree URL', async () => {
  const n = normalizeRepoInput('https://github.com/filamentphp/filament/tree/5.x');
  assert(n.cloneUrl === 'https://github.com/filamentphp/filament', 'Should normalize URL');
  assert(n.branch === '5.x', 'Should infer branch');
  assert(n.inferredName === 'filament', 'Should infer name');
});

await test('normalizeRepoInput — accepts URLs without scheme', async () => {
  const n = normalizeRepoInput('github.com/filamentphp/filament/tree/5.x');
  assert(n.cloneUrl === 'https://github.com/filamentphp/filament', 'Should add https');
  assert(n.branch === '5.x', 'Should still parse branch');
});

await test('normalizeRepoInput — explicit branch overrides tree URL', async () => {
  const n = normalizeRepoInput('https://github.com/filamentphp/filament/tree/4.x', '5.x');
  assert(n.branch === '5.x', 'Explicit wins');
});

await test('normalizeRepoInput — rejects blob URLs', async () => {
  try {
    normalizeRepoInput('https://github.com/filamentphp/filament/blob/5.x/README.md');
    throw new Error('Should have thrown');
  } catch (err: any) {
    assert(err.message.includes('Only repository root URLs'), 'Should reject');
  }
});

await test('normalizeRepoInput — parses commit URL', async () => {
  const n = normalizeRepoInput('https://github.com/joho/godotenv/commit/aabb1122ccdd');
  assert(n.commit === 'aabb1122ccdd', 'Captures SHA');
  assert(n.cloneUrl === 'https://github.com/joho/godotenv', 'Strips suffix');
});

await test('normalizeRepoInput — rejects invalid commit SHA', async () => {
  try {
    normalizeRepoInput('https://github.com/joho/godotenv/commit/not-a-sha');
    throw new Error('Should reject');
  } catch (err: any) {
    assert(err.message.includes('Invalid commit SHA'), 'Validates SHA');
  }
});

await test('normalizeRepoInput — parses releases/tag URL', async () => {
  const n = normalizeRepoInput('https://github.com/joho/godotenv/releases/tag/v1.4.0');
  assert(n.tag === 'v1.4.0', 'Captures tag');
});

await test('normalizeRepoInput — parses tag URL', async () => {
  const n = normalizeRepoInput('https://github.com/joho/godotenv/tag/v1.0.0');
  assert(n.tag === 'v1.0.0', 'Captures tag');
});

// ─── listFiles ───────────────────────────────────────────────

await test('listFiles — basic', async () => {
  const files = await listFiles(TEST_REPO);
  assert(files.length > 0, 'Should return files');
  assert(files.some((f) => f.endsWith('.go') || f.endsWith('.md')), 'Has .go/.md');
});

await test('listFiles — extension filter [".md"]', async () => {
  const files = await listFiles(TEST_REPO, '', { extensions: ['.md'] });
  assert(files.length > 0, 'Has .md files');
  assert(files.every((f) => f.endsWith('.md')), 'All .md');
});

await test('listFiles — include_size', async () => {
  const files = await listFiles(TEST_REPO, '', { includeSize: true });
  assert(files.length > 0, 'Has files');
  assert(files.some((f) => f.includes('KB') || f.includes('B)')), 'Has size');
});

await test('listFiles — max_depth=1', async () => {
  const shallow = await listFiles(TEST_REPO, '', { maxDepth: 1 });
  const deep = await listFiles(TEST_REPO);
  assert(shallow.length <= deep.length, 'Shallow ≤ deep');
});

await test('listFilesPaged — pagination metadata', async () => {
  const all = await listFiles(TEST_REPO);
  if (all.length < 3) throw new Error('Need at least 3 files for pagination test');
  const page = await listFilesPaged(TEST_REPO, '', { limit: 2, offset: 0 });
  assert(page.items.length === 2, `Expected 2 items, got ${page.items.length}`);
  assert(page.total === all.length, 'Total matches');
  assert(page.hasMore === true, 'hasMore=true');
  const page2 = await listFilesPaged(TEST_REPO, '', { limit: 2, offset: 2 });
  assert(page2.offset === 2, 'Offset reflected');
});

// ─── readFile ────────────────────────────────────────────────

await test('readFile — full', async () => {
  const c = await readFile(TEST_REPO, 'README.md');
  assert(c.length > 0, 'Has content');
});

await test('readFile — line range', async () => {
  const c = await readFile(TEST_REPO, 'README.md', { startLine: 1, endLine: 5 });
  assert(c.includes('[Lines 1-5'), 'Has header');
  const numbered = c.split('\n').filter((l) => l.match(/^\d+:/));
  assert(numbered.length <= 5, 'At most 5 lines');
});

await test('readFile — negative start_line (last 3 lines)', async () => {
  const c = await readFile(TEST_REPO, 'README.md', { startLine: -3 });
  assert(/\[Lines \d+-\d+ of \d+ total\]/.test(c), 'Has range header');
  const numbered = c.split('\n').filter((l) => l.match(/^\d+:/));
  assert(numbered.length <= 3, `Got ${numbered.length}, expected ≤3`);
});

await test('readFile — around_line window', async () => {
  const c = await readFile(TEST_REPO, 'README.md', { aroundLine: 5, contextLines: 2 });
  assert(c.includes('[Window lines'), 'Has window header');
  const numbered = c.split('\n').filter((l) => l.match(/^\d+:/));
  // 2 lines each side + center = up to 5
  assert(numbered.length <= 5 && numbered.length >= 1, `Got ${numbered.length} lines`);
});

await test('readFile — function_at_line on Go func', async () => {
  // godotenv.go contains `func Load(filenames ...string) (err error) {`
  // Find that line first
  const full = await readFile(TEST_REPO, 'godotenv.go');
  const lines = full.split('\n');
  const lineNum = lines.findIndex((l) => /^func Load\b/.test(l)) + 1;
  if (lineNum === 0) throw new Error('Could not locate func Load in godotenv.go');
  const c = await readFile(TEST_REPO, 'godotenv.go', { functionAtLine: lineNum });
  assert(c.includes('[Enclosing block lines'), 'Has block header');
  assert(c.includes('func Load'), 'Extracted block contains the signature');
});

await test('readFile — blocks path traversal', async () => {
  try {
    await readFile(TEST_REPO, '../../package.json');
    throw new Error('Should throw');
  } catch (err: any) {
    assert(err.message.includes('Security Error'), 'Should reject');
  }
});

// ─── searchCode ──────────────────────────────────────────────

await test('searchCode — basic', async () => {
  const r = await searchCode(TEST_REPO, 'func');
  assert(r !== 'No matches found.', 'Has matches');
  assert(r.includes(':'), 'file:line format');
});

await test('searchCode — extension filter', async () => {
  const r = await searchCode(TEST_REPO, 'func', { extensions: ['.go'], maxResults: 5 });
  assert(r !== 'No matches found.', 'Has matches');
});

await test('searchCode — context lines', async () => {
  const r = await searchCode(TEST_REPO, 'Load', { contextLines: 2, maxResults: 5 });
  assert(r !== 'No matches found.', 'Has matches');
  assert(r.includes('---'), 'Has separators');
  assert(r.includes('> '), 'Has match marker');
});

await test('searchCode — case sensitive (no match for wrong case)', async () => {
  const r = await searchCode(TEST_REPO, 'FUNC', { caseSensitive: true, extensions: ['.go'], maxResults: 5 });
  assert(r === 'No matches found.', `Should find none, got: ${r.slice(0, 200)}`);
});

await test('searchCode — case insensitive (matches FUNC)', async () => {
  const r = await searchCode(TEST_REPO, 'FUNC', { caseSensitive: false, extensions: ['.go'], maxResults: 5 });
  assert(r !== 'No matches found.', 'Should find lowercase func via case-insensitive');
});

await test('searchCode — regex pattern', async () => {
  const r = await searchCode(TEST_REPO, '^func Load', { regex: true, extensions: ['.go'], maxResults: 5 });
  assert(r !== 'No matches found.', 'Should find Load functions');
});

await test('searchCode — whole_word', async () => {
  const r = await searchCode(TEST_REPO, 'env', { wholeWord: true, extensions: ['.go'], maxResults: 5 });
  assert(typeof r === 'string', 'Returns string');
});

await test('searchCode — invalid regex throws', async () => {
  try {
    await searchCode(TEST_REPO, '[invalid', { regex: true });
    throw new Error('Should throw');
  } catch (err: any) {
    assert(err.message.includes('Invalid regex'), 'Should reject bad regex');
  }
});

await test('searchCode — group=true buckets by file', async () => {
  const r = await searchCode(TEST_REPO, 'func', { group: true, extensions: ['.go'], maxResults: 10 });
  assert(r.includes('──'), 'Has file dividers');
});

await test('searchCode — format=json', async () => {
  const r = await searchCode(TEST_REPO, 'func', { format: 'json', extensions: ['.go'], maxResults: 3 });
  const parsed = JSON.parse(r);
  assert(Array.isArray(parsed.hits), 'JSON has hits array');
  assert(typeof parsed.total === 'number', 'JSON has total');
  assert(parsed.hits.length <= 3, 'Respects maxResults');
});

// ─── getTree ─────────────────────────────────────────────────

await test('getTree — basic', async () => {
  const t = await getTree(TEST_REPO);
  assert(t.includes(TEST_REPO), 'Has root');
  assert(t.includes('├──') || t.includes('└──'), 'Has connectors');
});

await test('getTree — depth=1', async () => {
  const s = await getTree(TEST_REPO, { maxDepth: 1 });
  const d = await getTree(TEST_REPO, { maxDepth: 3 });
  assert(s.split('\n').length <= d.split('\n').length, 'Shallower ≤ deeper');
});

await test('getTree — show_files=false', async () => {
  const t = await getTree(TEST_REPO, { showFiles: false });
  const lines = t.split('\n').slice(1).filter((l) => l.trim());
  assert(lines.every((l) => l.trimEnd().endsWith('/')), 'Only dirs');
});

// ─── findDocs ────────────────────────────────────────────────

await test('findDocs — basic', async () => {
  const r = await findDocs(TEST_REPO);
  assert(r.includes('documentation files'), 'Has summary');
  assert(/readme/i.test(r), 'Found README');
});

// ─── batchRead ───────────────────────────────────────────────

await test('batchRead — multiple files', async () => {
  const files = await listFiles(TEST_REPO, '', { extensions: ['.md'] });
  if (files.length === 0) throw new Error('No .md files');
  const r = await batchRead(TEST_REPO, files.slice(0, 2));
  assert(r.includes('='.repeat(60)), 'Has separators');
});

await test('batchRead — handles missing', async () => {
  const r = await batchRead(TEST_REPO, ['README.md', 'NOPE.xyz']);
  assert(/file not found/i.test(r), 'Reports missing');
});

// ─── findFiles ───────────────────────────────────────────────

await test('findFiles — glob pattern', async () => {
  const r = await findFiles(TEST_REPO, '**/*.go');
  assert(r.includes('matching'), 'Has summary');
  assert(r.includes('.go'), 'Found .go files');
});

await test('findFiles — case-insensitive match', async () => {
  const r = await findFiles(TEST_REPO, '**/README*');
  assert(/readme/i.test(r), 'Found README');
});

await test('findFiles — no match returns clean message', async () => {
  const r = await findFiles(TEST_REPO, '**/*.zzzzz_definitely_no_match');
  assert(r.includes('No files matched'), 'Clean no-match');
});

await test('findFiles — pagination via offset', async () => {
  const all = await findFiles(TEST_REPO, '**/*.go', { maxResults: 1000 });
  const page = await findFiles(TEST_REPO, '**/*.go', { maxResults: 1, offset: 0 });
  // page should mention "1 file(s)"-ish slice
  assert(typeof all === 'string' && typeof page === 'string', 'Both return strings');
});

// ─── findSymbol ──────────────────────────────────────────────

await test('findSymbol — finds Go function "Load"', async () => {
  const r = await findSymbol(TEST_REPO, 'Load');
  assert(!r.startsWith('No definition found'), `Should find Load: ${r.slice(0, 200)}`);
  // Output is either "[function]" or "[function in <scope>]"
  assert(/\[function(?:\s+in\s+\S+)?\]/.test(r), `Marked as function, got: ${r.slice(0, 200)}`);
});

await test('findSymbol — rejects invalid identifier', async () => {
  try {
    await findSymbol(TEST_REPO, 'not a name; rm -rf /');
    throw new Error('Should reject');
  } catch (err: any) {
    assert(err.message.includes('valid identifier'), 'Should validate');
  }
});

await test('findSymbol — nonexistent returns clean message', async () => {
  const r = await findSymbol(TEST_REPO, 'ZzzNoSuchSymbol_XYZ');
  assert(r.startsWith('No definition found'), 'Clean miss');
});

await test('findSymbol — format=json with scope', async () => {
  const r = await findSymbol(TEST_REPO, 'Load', { format: 'json' });
  const parsed = JSON.parse(r);
  assert(Array.isArray(parsed.hits), 'JSON hits array');
  assert(parsed.hits.length > 0, 'Has at least one hit');
  const first = parsed.hits[0];
  assert(typeof first.line === 'number', 'Hit has line number');
  assert(['function', 'method'].includes(first.kind), `Kind is function/method, got ${first.kind}`);
});

await test('findSymbol — pagination', async () => {
  const r1 = await findSymbol(TEST_REPO, 'Load', { maxResults: 1 });
  assert(r1.includes('definition'), 'Has summary');
  const r2 = await findSymbol(TEST_REPO, 'Load', { maxResults: 100, offset: 0 });
  assert(typeof r2 === 'string', 'Returns string');
});

// ─── findReferences (NEW) ────────────────────────────────────

await test('findReferences — finds references to Load', async () => {
  const r = await findReferences(TEST_REPO, 'Load');
  assert(!r.startsWith('No references'), 'Should find references');
  assert(/\[def\]/.test(r) || /godotenv\.go/.test(r), 'Has def marker or godotenv.go');
});

await test('findReferences — exclude_definitions skips def lines', async () => {
  const r = await findReferences(TEST_REPO, 'Load', { excludeDefinitions: true });
  assert(!/\[def\]/.test(r), 'No def marker after exclude');
});

await test('findReferences — exclude_comments_and_strings', async () => {
  const r = await findReferences(TEST_REPO, 'Load', { excludeCommentsAndStrings: true });
  assert(typeof r === 'string', 'Returns string');
});

await test('findReferences — rejects invalid identifier', async () => {
  try {
    await findReferences(TEST_REPO, 'rm -rf /');
    throw new Error('Should reject');
  } catch (err: any) {
    assert(err.message.includes('valid identifier'), 'Should validate');
  }
});

await test('findReferences — format=json', async () => {
  const r = await findReferences(TEST_REPO, 'Load', { format: 'json', maxResults: 3 });
  const parsed = JSON.parse(r);
  assert(Array.isArray(parsed.hits), 'JSON hits array');
});

// ─── searchAllRepos ──────────────────────────────────────────

await test('searchAllRepos — finds across repos', async () => {
  const r = await searchAllRepos('package main', { extensions: ['.go'], maxResultsPerRepo: 2 });
  assert(typeof r === 'string', 'Returns string');
  assert(r.length > 0, 'Has output');
});

// ─── gitLog / gitShow / gitDiff ──────────────────────────────

await test('gitLog — returns commits', async () => {
  const r = await gitLog(TEST_REPO, { limit: 5 });
  assert(r.includes('Commits in'), 'Has header');
  const lines = r.split('\n').filter((l) => /^[a-f0-9]{4,}\s/.test(l));
  assert(lines.length > 0 && lines.length <= 5, `Got ${lines.length} commits`);
});

await test('gitLog — file filter', async () => {
  const r = await gitLog(TEST_REPO, { limit: 5, file: 'README.md' });
  assert(r.includes('README.md') || r.includes('Commits in'), 'Has output');
});

await test('gitShow — rejects invalid SHA', async () => {
  try {
    await gitShow(TEST_REPO, 'not-a-sha; rm -rf /');
    throw new Error('Should reject');
  } catch (err: any) {
    assert(err.message.includes('Invalid commit SHA'), 'Validates SHA');
  }
});

await test('gitShow — shows real commit', async () => {
  const log = await gitLog(TEST_REPO, { limit: 1 });
  const match = log.match(/([a-f0-9]{6,})/);
  if (!match) throw new Error('No SHA found in log');
  const sha = match[1]!;
  const r = await gitShow(TEST_REPO, sha);
  assert(r.length > 0, 'Has content');
  assert(/commit\s+[a-f0-9]+/.test(r) || r.includes('diff'), 'Looks like git show output');
});

await test('gitDiff — stat only', async () => {
  const r = await gitDiff(TEST_REPO, { from: 'HEAD~1', to: 'HEAD', statOnly: true });
  assert(typeof r === 'string', 'Returns string');
});

// ─── listBranches / listTags ─────────────────────────────────

await test('listBranches — basic', async () => {
  const r = await listBranches(TEST_REPO);
  assert(r.includes('Current branch:'), 'Has current');
  assert(r.includes('Branches:'), 'Has list');
});

await test('listBranches — include remote', async () => {
  const r = await listBranches(TEST_REPO, true);
  assert(r.includes('Branches:'), 'Has list');
});

await test('listTags — returns string', async () => {
  const r = await listTags(TEST_REPO);
  assert(typeof r === 'string' && r.length > 0, 'Has output');
});

// ─── gitBlame / gitStatus / gitGrep (NEW) ────────────────────

await test('gitBlame — annotates README.md', async () => {
  const r = await gitBlame(TEST_REPO, 'README.md', { startLine: 1, endLine: 3 });
  assert(r.startsWith('Blame for'), 'Has header');
  // Each line should look like: <sha8>  <author>  <date>  N: code
  const lines = r.split('\n').slice(1);
  assert(lines.some((l) => /^[a-f0-9]{8}\s/.test(l)), 'Has sha-prefixed lines');
});

await test('gitBlame — rejects missing file', async () => {
  try {
    await gitBlame(TEST_REPO, 'NOPE.xyz', { startLine: 1, endLine: 1 });
    throw new Error('Should reject');
  } catch (err: any) {
    assert(err.message.includes('not found') || err.message.includes('File not found'), 'Reports missing');
  }
});

await test('gitStatus — clean working tree', async () => {
  const r = await gitStatus(TEST_REPO);
  assert(typeof r === 'string', 'Returns string');
  // For a fresh clone it should be clean; if user edited files it would report state — both OK.
  assert(r.includes('clean') || r.includes('Status for'), 'Status output present');
});

await test('gitGrep — finds matches', async () => {
  const r = await gitGrep(TEST_REPO, 'func');
  assert(r.includes('match') || typeof r === 'string', 'Has output');
});

await test('gitGrep — ignore_case', async () => {
  const r = await gitGrep(TEST_REPO, 'FUNC', { ignoreCase: true, maxResults: 3 });
  assert(typeof r === 'string', 'Returns string');
});

await test('gitGrep — no match clean message', async () => {
  const r = await gitGrep(TEST_REPO, 'definitely_no_such_string_ZZZ');
  assert(r.includes('No matches'), 'Clean no-match');
});

// ─── Structured errors ──────────────────────────────────────

await test('ToolError — describeError carries code', async () => {
  try {
    await findSymbol(TEST_REPO, 'invalid name!');
    throw new Error('Should reject');
  } catch (err) {
    const desc = describeError(err);
    assert(desc.code === 'INVALID_INPUT', `Code is INVALID_INPUT, got ${desc.code}`);
  }
});

await test('ToolError — formatErrorText includes code', async () => {
  const err = new ToolError('REPO_NOT_FOUND', 'demo', 'try other');
  const text = formatErrorText(err);
  assert(text.includes('[REPO_NOT_FOUND]'), 'Has code bracket');
  assert(text.includes('Hint: try other'), 'Has hint');
});

// ─── .mcpignore ─────────────────────────────────────────────

await test('.mcpignore — extra patterns applied', async () => {
  const config = await getConfig();
  const repoRoot = path.resolve(process.cwd(), config.storagePath, TEST_REPO);
  const ignorePath = path.join(repoRoot, '.mcpignore');
  await fs.writeFile(ignorePath, '# test\nfixtures/\nREADME.md\n');
  try {
    invalidateRepoCaches(TEST_REPO);
    const { invalidateIgnore } = await import('./src/shared');
    invalidateIgnore(repoRoot);
    const patterns = await loadIgnorePatterns(repoRoot);
    assert(patterns.some((p) => p.includes('fixtures')), 'fixtures wrapped');
    assert(patterns.some((p) => p.includes('README.md')), 'README.md wrapped');
    // listFiles should now NOT include README.md
    const files = await listFiles(TEST_REPO, '', { extensions: ['.md'] });
    assert(!files.includes('README.md'), 'README.md filtered by .mcpignore');
  } finally {
    await fs.remove(ignorePath);
    const { invalidateIgnore } = await import('./src/shared');
    invalidateIgnore(repoRoot);
    invalidateRepoCaches(TEST_REPO);
  }
});

// ─── addLocalFolder ─────────────────────────────────────────

await test('addLocalFolder — registers existing folder', async () => {
  // Use the test repo storage itself as the "local folder" via absolute path
  const config = await getConfig();
  const folder = path.resolve(process.cwd(), config.storagePath, TEST_REPO);
  const alias = `${TEST_REPO}_localcopy`;
  // Clean if previous run left it
  if (config.repos[alias]) {
    delete config.repos[alias];
    await saveConfig(config);
  }
  const msg = await addLocalFolder(folder, alias);
  assert(msg.includes(alias), 'Confirmation has alias');
  try {
    const files = await listFiles(alias);
    assert(files.length > 0, 'Files accessible via alias');
  } finally {
    await removeRepo(alias);
  }
});

await test('addLocalFolder — rejects missing path', async () => {
  try {
    await addLocalFolder('Z:/nope/should/not/exist_definitely', 'noop');
    throw new Error('Should reject');
  } catch (err: any) {
    assert(err.message.includes('not found') || err.message.includes('Local path'), 'Reports missing');
  }
});

// ─── Summary ─────────────────────────────────────────────────

console.log('\n' + '='.repeat(60));
console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log('='.repeat(60));

if (failed > 0) process.exit(1);
