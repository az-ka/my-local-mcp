# Local MCP Server (Git & File Reader)

A local **Model Context Protocol** (MCP) server that turns your AI client (Claude Desktop, Claude Code, Cursor, VS Code Continue/Cline, etc.) into a power user of your local git repositories. Clone repos, browse code, hunt symbols, and inspect commit history — all without burning API tokens on remote fetches.

> **v3.0** ships **18 tools** across repo management, git inspection, and file/code exploration.

---

## ✨ Features at a Glance

### Repo management
| Tool | Purpose |
| --- | --- |
| `add_repo` | Clone a public repo locally (supports `tree/<branch>` URLs) |
| `sync_repo` | `git pull` one repo or all of them |
| `list_repos` | List tracked repos with branch + last sync |
| `remove_repo` | Untrack & delete (or keep files with `keep_files=true`) |

### Git inspection
| Tool | Purpose |
| --- | --- |
| `git_log` | Commit history; filter by `file` or `since` ("2 weeks ago") |
| `git_show` | Full details/diff of one commit by SHA |
| `git_diff` | Diff between refs (branches, tags, commits); `stat_only` for big diffs |
| `list_branches` | Local branches (or all incl. `origin/*` with `include_remote`) |
| `list_tags` | Tags/releases sorted newest-first |

### File & code exploration
| Tool | Purpose |
| --- | --- |
| `list_files` | Recursive listing with ext + size + depth filters |
| `read_file` | Full or line-range read; **negative `start_line`** for tail-style reads |
| `search_code` | Text/regex grep; **skips binary files**; case-sensitive, regex, whole-word, context lines |
| `get_tree` | Visual ASCII directory tree |
| `find_docs` | Smart README / docs discovery, ranked + previewed |
| `batch_read` | Read many files in one call (capped per-file) |
| `find_files` | Find by glob name (e.g. `**/*Config*.ts`) |
| `find_symbol` | Locate **function/class/interface/type DEFINITIONS** across TS/JS, Python, Go, Rust, Java, Kotlin, C#, PHP, Ruby |
| `search_all_repos` | Run a query across every tracked repo at once |

### Why this beats raw "ask AI to read a remote repo"
- **No API token cost** for fetching files.
- **Faster**: glob + grep on local disk vs. round-tripping GitHub.
- **Branch-aware**: pin a specific version (e.g. `filament-v5` on branch `5.x`).
- **Symbol-aware**: `find_symbol` jumps to definitions instead of fuzzy text match.

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
bun run test.ts     # 43 integration tests
```

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
      "args": []
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

### VS Code — Continue

Edit `~/.continue/config.json`:

```json
{
  "experimental": {
    "modelContextProtocolServers": [
      {
        "transport": {
          "type": "stdio",
          "command": "D:/Ngoding/Bun/my-local-mcp/server.exe"
        }
      }
    ]
  }
}
```

### Verify it loaded
On startup the server logs to stderr:
```
Local MCP Server v3.0 running on StdIO — 18 tools loaded
```
Claude Desktop logs are at `%APPDATA%\Claude\logs\mcp-server-local-docs.log` (Windows). If tools don't appear: check the path is absolute, run `server.exe` manually to confirm it boots, and restart your client.

> **Updating the binary**: clients hold the executable open. To install a new build, **close the client first**, then `bun run build`, then reopen.

---

## 💬 Example Prompts

```
"Check if I have the 'svelte' repo locally. If not,
 add https://github.com/sveltejs/svelte."

"Add https://github.com/filamentphp/filament/tree/5.x as filament-v5."

"Sync all my local repositories."

"Where is `useAuth` defined in better-auth-docs?"
   → uses find_symbol

"Show me the last 10 commits to src/index.ts in atlas."
   → uses git_log with file filter

"Diff v1.5.0 vs v2.0.0 in drizzle-orm — stat only."
   → uses git_diff with stat_only=true

"Find all files matching **/test_*.py under src/ in convex-backend."
   → uses find_files

"Search for 'rate limit' across all my repos."
   → uses search_all_repos

"Read the last 100 lines of CHANGELOG.md in effect."
   → uses read_file with start_line=-100
```

---

## 🌿 Branch-Specific Repos

`add_repo` accepts a non-default branch in two ways:

```json
{ "url": "https://github.com/filamentphp/filament", "name": "filament-v5", "branch": "5.x" }
```

```json
{ "url": "https://github.com/filamentphp/filament/tree/5.x", "name": "filament-v5" }
```

Both clone with `--single-branch` to save space and speed.

---

## 🛡️ Security & Safety Notes

- **Path-traversal blocked**: every file op resolves under the repo root via `path.relative`.
- **Binary files skipped** in `search_code` (extension blocklist + null-byte sniff in first 4KB).
- **Identifier validation**: `find_symbol` rejects anything that isn't `[A-Za-z_$][A-Za-z0-9_$]*`.
- **SHA validation**: `git_show` only accepts 4–40 hex chars — no shell injection surface.
- **Diff truncation**: oversized diffs/files are truncated with a clear `[WARNING: ...]` marker.
- **No write access**: this server **does not** modify cloned repos. It only clones, pulls, and reads.

---

## 🗂️ Project Structure

```
my-local-mcp/
├── src/
│   ├── index.ts        # MCP server entry — registers all 18 tools
│   ├── config.ts       # settings.json + storage path resolution
│   └── tools/
│       ├── git.ts      # repo + history tools
│       └── files.ts    # file + symbol + search tools
├── storage/            # cloned repos live here (gitignored)
├── settings.json       # auto-generated tracked-repo registry (gitignored)
├── test.ts             # 43 integration tests
├── server.exe          # compiled binary (after bun run build)
└── package.json
```

---

## 🧪 Tests

```bash
bun run test.ts
```

Covers all tools end-to-end against a real test repo (`godotenv`):
- URL normalization (incl. `tree/<branch>` parsing & rejection of invalid paths)
- File listing / reading / searching with every flag
- **Negative `start_line`** (last-N lines)
- **Path-traversal rejection**
- **Invalid-regex rejection** in `search_code`
- **Binary-file skip** (implicit — search avoids garbage decoding)
- `find_symbol` happy + invalid-identifier paths
- `git_log` / `git_show` / `git_diff` / `list_branches` / `list_tags`

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
