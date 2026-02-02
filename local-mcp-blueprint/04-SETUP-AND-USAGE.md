# 04 - Setup & Integration Guide

## 1. Development Setup

Instructions for you (the developer) to build this:

1. **Initialize Project:**

   ```bash
   mkdir my-local-mcp
   cd my-local-mcp
   bun init -y
   bun add @modelcontextprotocol/sdk zod simple-git fs-extra
   ```

2. **Develop:**
   - Create the files as described in documents 01, 02, and 03.
   - Run `bun build ./src/index.ts --compile --outfile server` (optional, to make a binary).

## 2. Integration with Claude Desktop

To use this with Claude, you need to edit the config file.

**Config Location:**

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

**Configuration JSON:**

```json
{
	"mcpServers": {
		"my-local-docs": {
			"command": "bun",
			"args": ["/absolute/path/to/my-local-mcp/src/index.ts"]
		}
	}
}
```

_Note: If you compiled it to a binary, change `command` to the binary path and remove `args`._

## 3. How to Use (Prompting the AI)

Once connected, you can talk to Claude like this:

> "I want to learn how Svelte Runes work. Please check if we have the 'svelte' repo in my local docs. If not, please add 'https://github.com/sveltejs/svelte'. Then, read the documentation files about Runes and explain them to me."

**What happens:**

1. AI calls `list_repos`.
2. If missing, AI calls `add_repo`.
3. AI calls `list_files` in the svelte repo.
4. AI calls `read_file` on relevant markdown files.
5. AI answers your question.
