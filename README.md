# DragApp MCP Server

An [MCP](https://modelcontextprotocol.io) server for [DragApp](https://dragapp.com) — the shared inbox built on Gmail. Read emails, reply, search threads, manage boards, and more from Claude, ChatGPT, Cursor, or any MCP-compatible AI tool.

## Setup

### 1. Get your API key

Go to [DragApp](https://app.dragapp.com) → Settings → Integrations → copy your API key.

### 2. Connect to your AI tool

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
- "Read the latest email from Acme Corp and draft a reply"
- "Move all billing threads to the Done column"
- "Search for emails mentioning 'invoice' on the Sales board"
- "What's my team's average response time this week?"
- "List all knowledge base articles"
- "Create a task on the Support board assigned to Sarah"

## Tools

### Email (8 tools)
`list_threads` · `get_thread` · `reply_to_thread` · `send_new_email` · `search_threads` · `filter_threads` · `move_thread` · `move_threads_bulk`

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

### Other
`add_comment` · `get_comment` · `list_tags` · `add_tag_to_card` · `create_task`

**43 tools total.**

## Development

```bash
git clone https://github.com/nick-timms/drag-mcp-server.git
cd drag-mcp-server
npm install
cp .env.example .env  # add your API key
npm run build
npm start
```

## License

MIT
