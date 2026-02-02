# 03 - Feature: File Reader (The "Brain")

## Goal

Allow the AI to explore the file structure, search for code patterns, and read the actual content of the documentation/code files locally.

## Tools to Implement

### 1. `list_files`

- **Description:** Lists files in a specific repository or subdirectory.
- **Arguments:**
  - `repo` (string): The name of the repository (e.g., "svelte").
  - `path` (string, optional): Subdirectory path (default: root).
- **Logic:**
  1. Resolve path: `storage/<repo>/<path>`.
  2. Use `fs.readdir` or `fast-glob` to list files.
  3. **Ignore:** `.git` folder, `node_modules`, `package-lock.json`, and binary files (images).
  4. Return a list of file paths.

### 2. `read_file`

- **Description:** Reads the content of a specific file.
- **Arguments:**
  - `repo` (string): The repository name.
  - `path` (string): Relative path to the file.
- **Logic:**
  1. Validate path exists.
  2. Check file size. **Limit:** If > 50KB, return a warning or truncated text to prevent crashing the context window.
  3. Read text content.
  4. Return the content string.

### 3. `search_code` (Optional but Recommended)

- **Description:** Grep/Search for a string pattern across a repository.
- **Arguments:**
  - `repo` (string): Repository to search.
  - `query` (string): Text/Regex to search for.
- **Logic:**
  1. Iterate through text files in `storage/<repo>`.
  2. Find matches.
  3. Return file paths and line numbers with context.

## Resources (MCP Feature)

Besides "Tools", the MCP protocol has a concept of "Resources".

- Expose each repo as a resource URI: `mcp://local-docs/<repo-name>/README.md`
- This allows the AI to "subscribe" to changes if needed (advanced, can be skipped for V1).

## Safety Restrictions

- **Sandboxing:** Ensure all file operations are strictly confined within the `storage/` directory.
- Reject paths containing `../` or absolute paths like `/etc/passwd`.
