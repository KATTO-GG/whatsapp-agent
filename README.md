# WhatsApp Agent Platform Integration for Claude Code

A Node.js agent that connects WhatsApp's Agent Platform API to Claude Code, enabling you to chat with Claude through WhatsApp.

## Features

- 🤖 **Full WhatsApp Agent Platform v1 support** — long-polling `/updates` endpoint, offset-based pagination
- 💬 **Persistent conversations** — each WhatsApp user gets their own Claude Code session (`--resume`)
- 🔒 **Deduplication** — message ID (`wamid`) tracking prevents duplicate processing
- 📸 **Image support** — download, analyze, and reply to images sent via WhatsApp
- 📁 **File sending** — send files (with size limits, ZIP bundling for large files)
- 🔔 **Proactive messaging** — send notifications/approvals to your WhatsApp from CLI
- ⚡ **Rate limit handling** — exponential backoff for 429 responses
- 🔄 **Auto-recovery** — handles 409 "poll replaced" gracefully

## Prerequisites

- Node.js 18+
- [Claude Code](https://claude.ai/code) installed and authenticated
- WhatsApp account with [Agent Platform access](https://faq.whatsapp.com/1050934623978152)

## Quick Start

### 1. Get WhatsApp Agent Platform Credentials
(Not availible in all regions yet)
1. Open WhatsApp on your phone
2. Go to **Settings → Agents → Create Agent**
3. Open the agent chat → **Chat Info** 
4. Copy the **API Key** and **User ID** (format: `user:1234567890`)

### 2. Install & Configure

```bash
git clone https://github.com/KATTO-GG/whatsapp-agent.git
cd whatsapp-agent
npm install
cp .env.example .env
```

### 3. Run the Agent

```bash
npm start
```

The agent will start polling for messages. Send a message to your agent on WhatsApp to test.

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `WHATSAPP_AGENT_API_TOKEN` | Yes | API token from WhatsApp Agent chat info |
| `MY_WHATSAPP_USER_ID` | No | Your user ID (enables proactive messaging) |

## Proactive Messaging (CLI → WhatsApp)

With `MY_WHATSAPP_USER_ID` set, you can send messages from your terminal:

```bash
# Send a text message
node sendProactiveMessage.js "Hello from CLI!"

# Send a file
node sendProactiveFile.js /path/to/file.pdf

# Notify task completion (for approval/input workflows)
node notifyTaskComplete.js "task-name" "Task completed successfully"
```

## Architecture

```
WhatsApp → Agent Platform API → Polling (/updates) 
  → Deduplication (wamid) 
  → Claude Code (--resume session per user) 
  → Response → Send Message API → WhatsApp
```

### Session Persistence

Each WhatsApp user maps to a UUID session stored in `.claude_sessions/`:
- First message → new `claude --resume <uuid>` session
- Subsequent messages → same session (context preserved)
- Sessions survive agent restarts

### Rate Limits

- **Polling**: 15 requests/minute (enforced server-side)
- **Agent**: 6s poll interval (10/min) + exponential backoff on 429
- **Messages**: Respects `retry-after` header

## File Handling

| Type | Max Size | Notes |
|------|----------|-------|
| Images | 16 MB | Downloaded, base64-embedded in prompt |
| Documents | 100 MB | Sent via upload → media ID |
| Large files | >100 MB | Auto-zipped, split if needed |

## Development

```bash
npm run dev  # Auto-reload on changes
```

## License

MIT
