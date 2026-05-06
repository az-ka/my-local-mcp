# Local MCP Server (Git & File Reader)

A local Model Context Protocol (MCP) server that acts as a bridge between your AI Client (Claude Desktop, Cursor, etc.) and your local git repositories. This allows your AI to autonomously clone repos, sync changes, explore code, and inspect git history locally — without burning API tokens on remote fetches.

## Features (v3.0 — 18 tools)

**Repo management**
- `add_repo` / `sync_repo` / `list_repos` / `remove_repo`

**Git inspection**
- `git_log`: commit history with file/since filters
- `git_show`: details/diff of a single commit
- `git_diff`: diff between refs (branch, tag, commit), with `stat_only` for big diffs
- `list_branches` (incl. remote) / `list_tags`

**File & code**
- `list_files`: recursive listing with ext + size + depth filters
- `read_file`: full or line-range read; supports negative `start_line` (e.g. `-50` = last 50 lines)
- `search_code`: text/regex search; **skips binary files**; supports `case_sensitive`, `regex`, `whole_word`, context lines, scope, ext filter
- `get_tree`: visual directory tree
- `find_docs`: smart README/docs discovery, ranked + previewed
- `batch_read`: read many files in one call
- `find_files`: glob by name (e.g. `**/*Config*.ts`)
- `find_symbol`: locate **function/class/interface/type definitions** by name across TS/JS, Python, Go, Rust, Java/Kotlin/C#, PHP, Ruby
- `search_all_repos`: search across every tracked repo at once

## Prerequisites

- [Bun](https://bun.com) (v1.0+)
- Git installed and available in your system `PATH`.

## Installation & Setup

1. **Clone/Download this project**:
   ```bash
   git clone <your-repo-url>
   cd my-local-mcp
   ```

2. **Install Dependencies**:
   ```bash
   bun install
   ```

3. **Build the Binary**:
   This compiles the project into a standalone executable (`server.exe` on Windows).
   ```bash
   bun run build
   ```

4. **Development/Test**:
   Run the server directly without building:
   ```bash
   bun run start
   ```

## Configuration

### 1. Claude Desktop
Edit your config file at:
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

Add the following to `mcpServers`:

```json
{
  "mcpServers": {
    "my-local-docs": {
      "command": "D:/AbsolutePath/To/my-local-mcp/server.exe",
      "args": []
    }
  }
}
```
*Make sure to replace the path with the actual absolute path to your `server.exe`.*

### 2. Cursor
1. Go to **Settings** (`Ctrl + Shift + J`) > **Features** > **MCP**.
2. Click **+ Add New MCP Server**.
3. Enter:
   - **Name**: `local-docs`
   - **Type**: `command`
   - **Command**: `D:/AbsolutePath/To/my-local-mcp/server.exe`

## Usage Examples

Once connected, you can ask your AI:

> "Check if I have the 'svelte' repo locally. If not, add 'https://github.com/sveltejs/svelte'."

> "Add `https://github.com/filamentphp/filament` using branch `5.x` and save it as `filament-v5`."

> "Add `https://github.com/filamentphp/filament/tree/5.x` as `filament-v5`."

> "Sync all my local repositories."

> "Search for 'onMount' in the svelte repository and explain how it is used based on the code found."

> "Where is `useAuth` defined in better-auth-docs?" (uses `find_symbol`)

> "Show me the last 10 commits to `src/index.ts` in atlas." (uses `git_log` with `file`)

> "Diff `v1.5.0` vs `v2.0.0` in drizzle-orm — stat only." (uses `git_diff` with `stat_only`)

> "Find all files matching `**/test_*.py` under `src/`." (uses `find_files`)

## Project Structure

- `src/tools/git.ts`: Logic for cloning and syncing repos.
- `src/tools/files.ts`: Logic for reading and searching files.
- `src/index.ts`: MCP Server entry point.
- `settings.json`: Stores the list of tracked repositories (auto-generated).
- `storage/`: Directory where repositories are cloned (ignored by git).

## Branch-specific repositories

`add_repo` now supports two ways to select a non-default branch:

- Pass the normal repository URL plus a `branch` value.
- Pass a GitHub URL in the form `https://github.com/<owner>/<repo>/tree/<branch>`.

Examples:

```json
{
  "url": "https://github.com/filamentphp/filament",
  "name": "filament-v5",
  "branch": "5.x"
}
```

```json
{
  "url": "https://github.com/filamentphp/filament/tree/5.x",
  "name": "filament-v5"
}
```

## References & Credits

- Inspired by [better-context](https://github.com/davis7dotsh/better-context/tree/main) for local context management.
- Built with [Model Context Protocol SDK](https://github.com/modelcontextprotocol/sdk).
