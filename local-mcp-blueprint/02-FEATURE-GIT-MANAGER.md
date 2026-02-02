# 02 - Feature: Git Manager (Automation)

## Goal

Allow the AI to autonomously manage the local library of documentation/codebases. The user shouldn't have to manually run `git clone` in the terminal.

## Tools to Implement

The MCP server must expose the following tools to the AI Client:

### 1. `add_repo`

- **Description:** Clones a remote GitHub repository to the local storage.
- **Arguments:**
  - `url` (string): The public GitHub URL.
  - `name` (string, optional): Alias for the repo (e.g., "svelte"). If empty, derive from repo name.
- **Logic:**
  1. Check if `storage/name` already exists.
  2. If no, run `git clone <url> storage/<name>`.
  3. Update `settings.json` with the new repo entry.
  4. Return success message "Repository [name] cloned successfully".

### 2. `sync_repo`

- **Description:** Pulls the latest changes for a specific repo or all repos.
- **Arguments:**
  - `name` (string, optional): Specific repo name. If "all" or empty, sync all.
- **Logic:**
  1. Navigate to `storage/<name>`.
  2. Run `git pull`.
  3. Update `lastSync` timestamp in `settings.json`.

### 3. `list_repos`

- **Description:** Lists all available local repositories.
- **Arguments:** None.
- **Logic:**
  1. Read `settings.json`.
  2. Return a formatted list of repos (Name, URL, Last Sync Status).

## Implementation Tips

- Use the `simple-git` library to handle commands safely.
- Ensure proper error handling (e.g., if git is not installed, or internet is down).
- **Security:** Validate that the `name` argument does not contain `..` or illegal characters to prevent directory traversal.
