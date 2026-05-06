/**
 * Integration test for the Local MCP server.
 * Run: bun run test.ts
 */
import {
  listFiles, readFile, searchCode, getTree, findDocs, batchRead,
  findFiles, findSymbol, searchAllRepos,
} from './src/tools/files';
import {
  listRepos, normalizeRepoInput,
  gitLog, gitShow, gitDiff, listBranches, listTags,
} from './src/tools/git';

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

console.log('='.repeat(60));
console.log('  LOCAL MCP v3.0 — Integration Tests');
console.log('='.repeat(60));
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
  // Should have at most 3 numbered lines
  const numbered = c.split('\n').filter((l) => l.match(/^\d+:/));
  assert(numbered.length <= 3, `Got ${numbered.length}, expected ≤3`);
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
  // Look for 'FUNC' in case-sensitive mode — Go uses lowercase 'func', should be 0 matches
  const r = await searchCode(TEST_REPO, 'FUNC', { caseSensitive: true, extensions: ['.go'], maxResults: 5 });
  assert(r === 'No matches found.', `Should find none, got: ${r.slice(0, 200)}`);
});

await test('searchCode — case insensitive (matches FUNC)', async () => {
  const r = await searchCode(TEST_REPO, 'FUNC', { caseSensitive: false, extensions: ['.go'], maxResults: 5 });
  assert(r !== 'No matches found.', 'Should find lowercase func via case-insensitive');
});

await test('searchCode — regex pattern', async () => {
  // Regex: function declarations starting with "Load"
  const r = await searchCode(TEST_REPO, '^func Load', { regex: true, extensions: ['.go'], maxResults: 5 });
  assert(r !== 'No matches found.', 'Should find Load functions');
});

await test('searchCode — whole_word', async () => {
  const r = await searchCode(TEST_REPO, 'env', { wholeWord: true, extensions: ['.go'], maxResults: 5 });
  // 'env' as whole word should match (e.g. var env, not envFile etc)
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

// ─── NEW: findFiles ──────────────────────────────────────────

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

// ─── NEW: findSymbol ─────────────────────────────────────────

await test('findSymbol — finds Go function "Load"', async () => {
  const r = await findSymbol(TEST_REPO, 'Load');
  assert(!r.startsWith('No definition found'), `Should find Load: ${r.slice(0, 200)}`);
  assert(/\[function\]/.test(r), 'Marked as function');
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

// ─── NEW: searchAllRepos ─────────────────────────────────────

await test('searchAllRepos — finds across repos', async () => {
  const r = await searchAllRepos('package main', { extensions: ['.go'], maxResultsPerRepo: 2 });
  assert(typeof r === 'string', 'Returns string');
  assert(r.length > 0, 'Has output');
});

// ─── NEW: gitLog / gitShow / gitDiff ─────────────────────────

await test('gitLog — returns commits', async () => {
  const r = await gitLog(TEST_REPO, { limit: 5 });
  assert(r.includes('Commits in'), 'Has header');
  // Each line should have SHA + date
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
  // Get a real SHA from gitLog first
  const log = await gitLog(TEST_REPO, { limit: 1 });
  const match = log.match(/([a-f0-9]{6,})/);
  if (!match) throw new Error('No SHA found in log');
  const sha = match[1]!;
  const r = await gitShow(TEST_REPO, sha);
  assert(r.length > 0, 'Has content');
  assert(/commit\s+[a-f0-9]+/.test(r) || r.includes('diff'), 'Looks like git show output');
});

await test('gitDiff — stat only', async () => {
  // Diff between HEAD~1 and HEAD
  const r = await gitDiff(TEST_REPO, { from: 'HEAD~1', to: 'HEAD', statOnly: true });
  assert(typeof r === 'string', 'Returns string');
});

// ─── NEW: listBranches / listTags ────────────────────────────

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
  // godotenv may or may not have tags — both ok
  assert(typeof r === 'string' && r.length > 0, 'Has output');
});

// ─── Summary ─────────────────────────────────────────────────

console.log('\n' + '='.repeat(60));
console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log('='.repeat(60));

if (failed > 0) process.exit(1);
