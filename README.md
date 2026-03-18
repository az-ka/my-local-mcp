# Local MCP Server (Git & File Reader)

A local Model Context Protocol (MCP) server that acts as a bridge between your AI Client (Claude Desktop, Cursor, etc.) and your local git repositories. This allows your AI to autonomously clone repos, sync changes, explore file structures, and read code locally.

## Features

- **Git Manager**:
  - `add_repo`: Clone public GitHub repositories locally, including specific branches.
  - `sync_repo`: Pull latest changes for tracked repositories.
  - `list_repos`: View all managed repositories.
- **File Reader**:
  - `list_files`: Recursively list files (ignoring `.git`, `node_modules`, etc.).
  - `read_file`: Read file content (smartly truncated at 50KB to save context).
  - `search_code`: Simple case-insensitive grep/search across files.

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
