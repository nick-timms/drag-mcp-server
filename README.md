# DragApp MCP Server

An [MCP](https://modelcontextprotocol.io) server for [DragApp](https://dragapp.com) — AI-powered email & WhatsApp for teams. Read and reply to emails, send WhatsApp messages, search threads, manage boards, and more from Claude, ChatGPT, Cursor, or any MCP-compatible AI tool.

## Setup

### Fastest: connect from your AI client (hosted)

Add this URL as a custom connector:

```
https://app.dragapp.com/mcp
```

- **Claude** — Settings → Connectors → Add custom connector → paste the URL
- **ChatGPT** — Settings → Connectors → Add → paste the URL
- **Gemini** — add it as a remote MCP server with the same URL

When you connect, a Drag page opens and asks for your API key once
([DragApp](https://app.dragapp.com) → Settings → Integrations). The key is
verified and handed to your client as its access token; the service stores
nothing, and the connect flow never puts your key in a URL. Works in any
client that supports remote MCP connectors (OAuth 2.1 + PKCE, dynamic client
registration). Nothing to install.

### Local (config-file clients: Cursor, Windsurf, Claude Code)

#### 1. Get your API key

Go to [DragApp](https://app.dragapp.com) → Settings → Integrations → copy your API key.

#### 2. Connect to your AI tool

**Claude Desktop** — add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "dragapp": {
      "command": "npx",
      "args": ["-y", "@dragapp/mcp-server"],
      "env": {
        "DRAG_API_KEY": "your-api-key"
      }
    }
  }
}
```

**Cursor** — add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "dragapp": {
      "command": "npx",
      "args": ["-y", "@dragapp/mcp-server"],
      "env": {
        "DRAG_API_KEY": "your-api-key"
      }
    }
  }
}
```

Works with any MCP-compatible client — ChatGPT, Windsurf, Claude Code, etc.

## What you can do

Ask your AI assistant:

- "Show me unread emails on the Support board"
- "Read the latest email from Acme Corp and draft a reply for me to check"
- "What does the PDF attached to the latest invoice email say?"
- "Find every email about refunds from the last 90 days, archived ones included"
- "Set the Order number field on this card to 4521"
- "Move all billing threads to the Done column"
- "Search for emails mentioning 'invoice' on the Sales board"
- "What's my team's average response time this week?"
- "List all knowledge base articles"
- "Search our help center for how invoices work"
- "Assign the newest email on the Support board to Sarah"
- "Create a task on the Support board assigned to Sarah"

## Tools

### Email (10 tools)
`list_threads` · `get_thread` · `reply_to_thread` · `create_draft` · `get_draft` · `send_new_email` · `search_threads` · `filter_threads` · `move_thread` · `move_threads_bulk`

Replies and new emails are sent as the board's own sending address (its default sender, else its Google Group, else the board owner). `create_draft` saves a reply on the card for a person to review and send; nothing is sent. To edit an existing draft, read it with `get_draft` and write the new version with `create_draft` and `replace: true`. `get_thread` with `history: true` returns the whole conversation, incoming and outgoing. `search_threads` finds archived (closed) conversations too and takes date filters (`sinceDays`, `dateFrom`, `dateTo`) and paging (`limit`, `page`).

### Boards (5 tools)
`list_boards` · `get_board` · `list_columns` · `list_board_members` · `list_teams`

### Cards (6 tools)
`list_cards_in_column` · `get_card` · `create_card` · `update_card` · `move_card` · `archive_card`

### Labels (4 tools)
`list_labels` · `add_label_to_thread` · `remove_label_from_thread` · `toggle_labels`

### Contacts (3 tools)
`search_contacts` · `get_contact_conversations` · `create_contact`

### Knowledge Base (5 tools)
`list_articles` · `get_article` · `create_article` · `update_article` · `search_knowledge`

### Analytics (4 tools)
`get_response_times` · `get_avg_response_time` · `get_daily_activity` · `get_closed_activity`

### Automations (3 tools)
`list_automations` · `toggle_automation` · `toggle_ai_drafts`

### WhatsApp (4 tools)
`send_whatsapp_message` · `send_whatsapp_template` · `list_whatsapp_templates` · `get_whatsapp_conversation`

### Comments (2 tools)
`add_comment` · `get_comment`

### Tags (2 tools)
`list_tags` · `add_tag_to_card`

### Tasks (1 tool)
`create_task`

### Custom fields (2 tools)
`list_custom_fields` · `set_custom_field`

### Files (4 tools)
`read_attachment` · `list_card_files` · `read_card_file` · `read_note_image`

PDF (scanned ones included), Word, Excel (.xlsx), CSV, text, data files (JSON, XML, YAML, logs, TSV, Markdown, HTML) and images, up to 10 MB. Text is extracted by the server; pictures are passed to your AI client to read.

**55 tools across 14 categories.**

## Development

```bash
git clone https://github.com/nick-timms/drag-mcp-server.git
cd drag-mcp-server
npm install
cp .env.example .env  # add your API key
npm run build
npm test      # node --test, no network needed
npm start
```

### Secret-scanning pre-commit hook

This is a **public** repository. Before committing, install the pre-commit hook so
[gitleaks](https://github.com/gitleaks/gitleaks) scans your staged changes for
secrets (keys, JWTs, tokens):

```bash
pip install pre-commit   # one-time, if you don't have it
pre-commit install       # installs the git hook in this repo
```

Run it manually against everything at any time:

```bash
pre-commit run --all-files
```

The hook uses [`.gitleaks.toml`](./.gitleaks.toml). The same scan runs in CI on every
push and pull request (`.github/workflows/secret-scan.yml`), and `npm publish` runs a
tarball guard (`scripts/check-tarball.mjs`) that blocks the release if the built
package contains any known-sensitive term.

## License

MIT
