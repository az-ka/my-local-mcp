# Local MCP Server (Git & File Reader)

A local **Model Context Protocol** (MCP) server that turns your AI client (Claude Desktop, Claude Code, Cursor, VS Code Continue/Cline, etc.) into a power user of your local git repositories. Clone repos, browse code, hunt symbols, trace references, and inspect commit history — all without burning API tokens on remote fetches.

> **v4.0** ships **24 tools + MCP Resources + curated Prompts** across repo management, git inspection, file/code exploration, and code navigation.

---

## ✨ Features at a Glance

### Repo management
| Tool | Purpose |
| --- | --- |
| `add_repo` | Clone a public repo locally (supports `tree/<branch>`, `commit/<sha>`, `releases/tag/<tag>` URLs; optional `depth`) |
| `add_local_folder` | Register a folder already on disk (git or non-git) as a tracked entry |
| `sync_repo` | `git pull` one repo or all of them (skips local-folder entries) |
| `list_repos` | List tracked repos, with `filter` substring + `sort` by name/lastSync/branch |
| `remove_repo` | Untrack & delete (or keep files with `keep_files=true`); local folders never get deleted |

### Git inspection
| Tool | Purpose |
| --- | --- |
| `git_log` | Commit history; filter by `file` or `since` ("2 weeks ago") |
| `git_show` | Full details/diff of one commit by SHA |
| `git_diff` | Diff between refs (branches, tags, commits); `stat_only` for big diffs |
| `git_blame` | Per-line author/commit annotation (optional line range) |
| `git_status` | Working-tree status (useful for local-folder entries you edit) |
| `git_grep` | Fast text search honoring `.gitignore` (5-10× faster than `search_code` on big repos) |
| `list_branches` | Local branches (or all incl. `origin/*` with `include_remote`) |
| `list_tags` | Tags/releases sorted newest-first |

### File & code exploration
| Tool | Purpose |
| --- | --- |
| `list_files` | Recursive listing with ext + size + depth filters + pagination (`offset` / `limit` / `hasMore`) |
| `read_file` | Full / line-range / `around_line` window / `function_at_line` enclosing-block extraction; **negative `start_line`** for tail-style reads |
| `search_code` | Text/regex grep; binary-skip; `group=true` to bucket by file; `format="json"` |
| `get_tree` | Visual ASCII directory tree |
| `find_docs` | Smart README / docs discovery, ranked + previewed |
| `batch_read` | Read many files in one call (capped per-file) |
| `find_files` | Find by glob name (e.g. `**/*Config*.ts`) with pagination |
| `find_symbol` | Locate **DEFINITIONS** across TS/JS, Python, Go, Rust, Java, Kotlin, C#, PHP, Ruby, Swift — kinds incl. function/method/class/interface/trait/type/enum/struct/impl/const; reports enclosing scope |
| `find_references` | Locate **callers/usages** of an identifier; optional comment/string stripping and `exclude_definitions` |
| `search_all_repos` | Run a query across every tracked repo at once |

### MCP Resources & Prompts
- **Resources** — every tracked repo is exposed as `localrepo://<repo>` (metadata blob) plus `localrepo://<repo>/<path>` (file template). Clients can `@`-mention files without a tool call.
- **Prompts (slash-commands)** — `explore-repo`, `find-impl`, `find-callers`, `changes-since`, `debug-symbol`. Each one packages a multi-step workflow into one shot.

### Why this beats raw "ask AI to read a remote repo"
- **No API token cost** for fetching files.
- **Faster**: glob + grep on local disk vs. round-tripping GitHub.
- **Branch / commit / tag aware**: pin a specific version (`tree/5.x`, `commit/<sha>`, `releases/tag/v1.4`).
- **Symbol-aware**: `find_symbol` jumps to definitions, `find_references` enumerates callers.
- **AI-friendly errors**: every error returns `[CODE] message` + optional hint — easy to branch on.

---

## 📋 Prerequisites

- [Bun](https://bun.com) v1.0+
- Git on `PATH`

---

## 🚀 Install

```bash
git clone https://github.com/az-ka/my-local-mcp.git
cd my-local-mcp
bun install
bun run build       # produces server.exe (Windows) or server (macOS/Linux)
```

For development without rebuilding:

```bash
bun run start       # runs src/index.ts directly
bun run typecheck   # tsc --noEmit
bun run test.ts     # 74 integration tests (auto-clones the test repo on first run)
```

---

## 🔧 Environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `MCP_DEBUG` | unset | When `1` / `true` / `yes`, logs each tool call + duration to stderr |
| `MCP_GITHUB_TOKEN` / `GITHUB_TOKEN` | unset | Token injected into HTTPS GitHub URLs at clone time (never stored in `settings.json`) |
| `MCP_CLONE_DEPTH` | `0` (full history) | Default shallow-clone depth applied when `add_repo` doesn't pass an explicit `depth` |
| `MCP_MAX_REPO_BYTES` | `2 GB` | Warn threshold after `add_repo`; informational only, doesn't fail |

---

## 🔌 Connecting Your AI Client

Replace the example path with the **absolute** path to your `server.exe` (Windows) or `server` binary.

### Claude Desktop

Edit:
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "local-docs": {
      "command": "D:/Ngoding/Bun/my-local-mcp/server.exe",
      "args": [],
      "env": {
        "MCP_GITHUB_TOKEN": "ghp_xxx"
      }
    }
  }
}
```

> On Windows JSON, escape backslashes (`\\`) **or** use forward slashes. Restart the app after saving.

### Claude Code (CLI)

```bash
claude mcp add local-docs "D:/Ngoding/Bun/my-local-mcp/server.exe"
claude mcp list   # verify
```

### Cursor

`Settings` → `Features` → `MCP` → `+ Add New MCP Server`
- **Name**: `local-docs`
- **Type**: `command`
- **Command**: `D:/Ngoding/Bun/my-local-mcp/server.exe`

### VS Code — Cline / Roo Code

Open the **MCP Servers** panel in the sidebar → `Edit MCP Settings` → add the same JSON shape as Claude Desktop.

### Verify it loaded
On startup the server logs to stderr:
```
Local MCP Server v4.0.0 running on StdIO — 24 tools + resources + prompts loaded
```
Claude Desktop logs are at `%APPDATA%\Claude\logs\mcp-server-local-docs.log` (Windows). If tools don't appear: check the path is absolute, run `server.exe` manually to confirm it boots, and restart your client.

> **Updating the binary**: clients hold the executable open. To install a new build, **close the client first**, then `bun run build`, then reopen.

---

## 💬 Example Prompts

```
"Add https://github.com/sveltejs/svelte."
"Add https://github.com/filamentphp/filament/tree/5.x as filament-v5."
"Add https://github.com/joho/godotenv/releases/tag/v1.4.0 — only that tag."
"Register C:/projects/my-app as a local folder named my-app."

"Sync all my local repositories."

"Where is `useAuth` defined in better-auth-docs?"          → find_symbol
"Who calls `useAuth`?"                                     → find_references with exclude_definitions
"Read the function around line 142 of src/auth.ts."        → read_file with function_at_line=142
"Show me 10 lines around line 80 of config.go."            → read_file with around_line=80, context_lines=5

"Who last touched lines 40-60 of godotenv.go?"             → git_blame
"What's the status of my-app working tree?"                → git_status
"git_grep 'rate_limit' in convex-backend."                 → git_grep

"Diff v1.5.0 vs v2.0.0 in drizzle-orm — stat only."        → git_diff with stat_only=true
"Show me last 10 commits to src/index.ts in atlas."        → git_log with file filter

"Find all files matching **/test_*.py under src/."         → find_files
"Search for 'rate limit' across all my repos."             → search_all_repos
"Read the last 100 lines of CHANGELOG.md in effect."       → read_file with start_line=-100
```

Slash-commands surfaced by the server (run in clients that support prompts):
- `/explore-repo <name>` — bootstrap a tour
- `/find-impl <symbol>` — locate + read the implementation
- `/find-callers <symbol>` — enumerate usages
- `/changes-since <ref>` — summarise recent changes
- `/debug-symbol <symbol>` — definition + callers + recent history walkthrough

---

## 🌿 Branch / Commit / Tag URLs

`add_repo` accepts any of:

```json
{ "url": "https://github.com/filamentphp/filament", "name": "filament-v5", "branch": "5.x" }
{ "url": "https://github.com/filamentphp/filament/tree/5.x", "name": "filament-v5" }
{ "url": "https://github.com/joho/godotenv/commit/aabbccdd1122", "name": "godotenv-pinned" }
{ "url": "https://github.com/joho/godotenv/releases/tag/v1.4.0", "name": "godotenv-1.4" }
```

Branch URLs clone with `--single-branch` to save space and speed. Commit/tag URLs check out the requested ref (commit = detached HEAD).

---

## 🗒️ Per-repo `.mcpignore`

Drop a `.mcpignore` file at the root of any cloned repo to add extra ignore patterns (merged with built-in defaults like `node_modules/`, `target/`, lockfiles):

```
# example .mcpignore
bazel-bin/
generated/
fixtures
```

Plain folder names are auto-wrapped to `**/<name>/**`. Glob patterns are used as-is. Cached for 60 s; deleting the file is picked up after the cache expiry or after `sync_repo`.

---

## 🛡️ Security & Safety Notes

- **Path-traversal blocked**: every file op resolves under the repo root via `path.relative` and rejects with `[PATH_TRAVERSAL]` errors.
- **Binary files skipped** in `search_code` / `find_references` (extension blocklist + null-byte sniff in first 4 KB).
- **Identifier validation**: `find_symbol` and `find_references` reject anything that isn't `[A-Za-z_$][A-Za-z0-9_$]*`.
- **SHA validation**: `git_show` and `commit/<sha>` URLs only accept 4-40 hex chars — no shell injection surface.
- **Diff truncation**: oversized diffs/files are truncated with a clear `[WARNING: ...]` marker.
- **Token never stored**: `MCP_GITHUB_TOKEN` is injected only at clone URL build time; `settings.json` keeps the public URL.
- **No write access to your code**: the server clones, pulls, and reads. It does not modify cloned repos or your local-folder entries.

---

## 🗂️ Project Structure

```
my-local-mcp/
├── src/
│   ├── index.ts        # MCP server entry — registers tools, resources, prompts
│   ├── config.ts       # settings.json + env var resolution
│   ├── shared.ts       # ToolError, debug log, TTL cache, ignore loader, path guards
│   ├── resources.ts    # Resource templates (localrepo://...)
│   ├── prompts.ts      # Curated slash-commands
│   └── tools/
│       ├── git.ts      # repo + history + blame/status/grep
│       └── files.ts    # file + symbol + references + cache invalidation
├── storage/            # cloned repos live here (gitignored)
├── settings.json       # auto-generated tracked-repo registry (gitignored)
├── test.ts             # 74 integration tests (self-bootstraps test repo)
├── server.exe          # compiled binary (after bun run build)
└── package.json
```

---

## 🧪 Tests

```bash
bun run test.ts
```

The suite **self-bootstraps**: if `godotenv` isn't already in `storage/`, it clones it on first run. Covers all 24 tools end-to-end:
- URL normalization for tree, commit, releases/tag, and tag URLs
- File listing / reading / searching with every flag (pagination, format=json, group)
- `read_file` modes: full, range, negative tail, `around_line` window, `function_at_line` block extraction
- **Path-traversal rejection**, **invalid-regex rejection**, **binary-file skip**
- `find_symbol` happy + invalid-identifier + scope-aware JSON output paths
- `find_references` with `exclude_definitions` and `exclude_comments_and_strings`
- `git_log` / `git_show` / `git_diff` / `git_blame` / `git_status` / `git_grep` / `list_branches` / `list_tags`
- `add_local_folder` happy + missing-path rejection
- `.mcpignore` extra patterns applied at scan time
- Structured `ToolError` payloads (`describeError`, `formatErrorText`)

---

## 🛠️ Tech

- [Bun](https://bun.com) — runtime + bundler + standalone-binary compiler
- [Model Context Protocol SDK](https://github.com/modelcontextprotocol/sdk)
- [simple-git](https://github.com/steveukx/git-js) — wraps system `git`
- [fast-glob](https://github.com/mrmlnc/fast-glob) — quick file globbing
- [zod](https://zod.dev) — input schema validation

---

## 🙏 Credits

- Inspired by [better-context](https://github.com/davis7dotsh/better-context) for local context management.
- Built on the official [Model Context Protocol SDK](https://github.com/modelcontextprotocol/sdk).

---

## 📜 License

MIT
