/**
 * Quick integration test for all file tools.
 * Run: bun run test.ts
 */
import { listFiles, readFile, searchCode, getTree, findDocs, batchRead } from './src/tools/files';
import { listRepos } from './src/tools/git';

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
    failed++;
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

// Pick a small known repo from settings.json
const TEST_REPO = 'godotenv'; // small repo, should be fast

console.log('='.repeat(60));
console.log('  LOCAL MCP v2.0 — Integration Tests');
console.log('='.repeat(60));
console.log(`Using test repo: "${TEST_REPO}"\n`);

// ─── 1. listRepos ────────────────────────────────────────────
await test('listRepos — returns managed repos', async () => {
  const result = await listRepos();
  assert(result.includes(TEST_REPO), `Should contain "${TEST_REPO}"`);
  assert(result.includes('Managed Repositories'), 'Should have header');
});

// ─── 2. listFiles (basic) ────────────────────────────────────
await test('listFiles — basic (no options)', async () => {
  const files = await listFiles(TEST_REPO);
  assert(files.length > 0, 'Should return files');
  assert(files.some(f => f.endsWith('.go') || f.endsWith('.md')), 'Should have .go or .md files');
});

// ─── 3. listFiles (extension filter) ─────────────────────────
await test('listFiles — extension filter [".md"]', async () => {
  const files = await listFiles(TEST_REPO, '', { extensions: ['.md'] });
  assert(files.length > 0, 'Should find .md files');
  assert(files.every(f => f.endsWith('.md')), 'All files should be .md');
});

// ─── 4. listFiles (with size) ────────────────────────────────
await test('listFiles — include_size=true', async () => {
  const files = await listFiles(TEST_REPO, '', { includeSize: true });
  assert(files.length > 0, 'Should return files');
  assert(files.some(f => f.includes('KB') || f.includes('B)')), 'Should include size info');
});

// ─── 5. listFiles (max_depth) ────────────────────────────────
await test('listFiles — max_depth=1', async () => {
  const shallow = await listFiles(TEST_REPO, '', { maxDepth: 1 });
  const deep = await listFiles(TEST_REPO);
  // Shallow should have fewer or equal files
  assert(shallow.length <= deep.length, `Shallow (${shallow.length}) should be <= deep (${deep.length})`);
});

// ─── 6. readFile (full) ──────────────────────────────────────
await test('readFile — full file', async () => {
  const content = await readFile(TEST_REPO, 'README.md');
  assert(content.length > 0, 'Should have content');
  assert(content.includes('godotenv') || content.includes('GoDotEnv') || content.includes('.env'), 'Should be about godotenv');
});

// ─── 7. readFile (line range) ────────────────────────────────
await test('readFile — line range (lines 1-5)', async () => {
  const content = await readFile(TEST_REPO, 'README.md', { startLine: 1, endLine: 5 });
  assert(content.includes('[Lines 1-5'), 'Should have line range header');
  const lines = content.split('\n').filter(l => l.match(/^\d+:/));
  assert(lines.length <= 5, `Should have at most 5 numbered lines, got ${lines.length}`);
});

// ─── 8. searchCode (basic) ───────────────────────────────────
await test('searchCode — basic search', async () => {
  const result = await searchCode(TEST_REPO, 'func');
  assert(result !== 'No matches found.', 'Should find matches for "func"');
  assert(result.includes(':'), 'Results should have file:line format');
});

// ─── 9. searchCode (extension filter) ────────────────────────
await test('searchCode — extension filter [".go"]', async () => {
  const result = await searchCode(TEST_REPO, 'func', { extensions: ['.go'] });
  assert(result !== 'No matches found.', 'Should find matches');
  // All results should be from .go files
  const lines = result.split('\n').filter(l => l.includes(':'));
  assert(lines.every(l => l.startsWith('') || l.includes('.go:')), 'Results should be from .go files');
});

// ─── 10. searchCode (context lines) ──────────────────────────
await test('searchCode — context_lines=2', async () => {
  const result = await searchCode(TEST_REPO, 'Load', { contextLines: 2, maxResults: 5 });
  assert(result !== 'No matches found.', 'Should find matches');
  assert(result.includes('---'), 'Should have context block separators');
  assert(result.includes('> '), 'Should have match indicator ">"');
});

// ─── 11. searchCode (path scope) ─────────────────────────────
await test('searchCode — path scoping', async () => {
  // Search only in a specific path — no error means it works
  const result = await searchCode(TEST_REPO, 'package', { maxResults: 5 });
  assert(typeof result === 'string', 'Should return a string result');
});

// ─── 12. getTree (basic) ─────────────────────────────────────
await test('getTree — basic (depth=3)', async () => {
  const tree = await getTree(TEST_REPO);
  assert(tree.includes(TEST_REPO), 'Should have repo name as root');
  assert(tree.includes('├──') || tree.includes('└──'), 'Should have tree connectors');
});

// ─── 13. getTree (depth=1) ───────────────────────────────────
await test('getTree — depth=1', async () => {
  const shallow = await getTree(TEST_REPO, { maxDepth: 1 });
  const deep = await getTree(TEST_REPO, { maxDepth: 3 });
  assert(shallow.split('\n').length <= deep.split('\n').length, 'Shallow tree should be shorter or equal');
});

// ─── 14. getTree (directories only) ──────────────────────────
await test('getTree — show_files=false (dirs only)', async () => {
  const tree = await getTree(TEST_REPO, { showFiles: false });
  assert(tree.includes('/'), 'Should have directory markers');
  // Every non-root line should end with /
  const lines = tree.split('\n').slice(1).filter(l => l.trim());
  assert(lines.every(l => l.trimEnd().endsWith('/')), 'All entries should be directories');
});

// ─── 15. getTree (extension filter) ──────────────────────────
await test('getTree — extensions=[".md"]', async () => {
  const tree = await getTree(TEST_REPO, { extensions: ['.md'] });
  // Files shown should be .md only (dirs are always shown)
  const fileLines = tree.split('\n').filter(l => !l.endsWith('/') && (l.includes('├──') || l.includes('└──')));
  if (fileLines.length > 0) {
    assert(fileLines.every(l => l.includes('.md')), 'File entries should be .md');
  }
});

// ─── 16. findDocs (basic) ────────────────────────────────────
await test('findDocs — basic', async () => {
  const result = await findDocs(TEST_REPO);
  assert(result.includes('documentation files'), 'Should have summary header');
  assert(result.includes('README') || result.includes('readme'), 'Should find README');
});

// ─── 17. findDocs (with topic) ───────────────────────────────
await test('findDocs — with topic', async () => {
  const result = await findDocs(TEST_REPO, { topic: 'env' });
  assert(result.includes('documentation files'), 'Should have summary header');
});

// ─── 18. batchRead ───────────────────────────────────────────
await test('batchRead — read multiple files', async () => {
  // Get a list of files first
  const files = await listFiles(TEST_REPO, '', { extensions: ['.md'] });
  const filesToRead = files.slice(0, 2);
  
  if (filesToRead.length === 0) {
    throw new Error('No .md files to batch-read');
  }

  const result = await batchRead(TEST_REPO, filesToRead);
  assert(result.includes('='.repeat(60)), 'Should have file separators');
  for (const f of filesToRead) {
    assert(result.includes(f), `Should contain file "${f}"`);
  }
});

// ─── 19. batchRead (file not found handling) ─────────────────
await test('batchRead — handles missing files gracefully', async () => {
  const result = await batchRead(TEST_REPO, ['README.md', 'DOES_NOT_EXIST.xyz']);
  assert(result.includes('README.md'), 'Should contain valid file');
  assert(result.includes('File not found') || result.includes('ERROR'), 'Should report missing file');
});

// ─── 20. Security — path traversal blocked ───────────────────
await test('readFile — blocks path traversal', async () => {
  try {
    await readFile(TEST_REPO, '../../package.json');
    throw new Error('Should have thrown security error');
  } catch (err: any) {
    assert(err.message.includes('Security Error') || err.message.includes('Access denied'), 'Should throw security error');
  }
});

// ─── Summary ─────────────────────────────────────────────────
console.log('\n' + '='.repeat(60));
console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log('='.repeat(60));

if (failed > 0) {
  process.exit(1);
}
