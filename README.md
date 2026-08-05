# claude-code-bridge

A tiny, secure **loopback WebSocket bridge** that streams a real **Claude Code**
session into any web app — a live terminal, a chat Q&A, or "look at my screen"
vision — using your **Claude Code subscription**, not paid API credits.

Web pages can't spawn local processes or reach your repos. This ~300-line Node
process runs on *your* machine (where `claude` and your code live) and exposes a
loopback socket a web UI can talk to. Same idea as VS Code's remote terminal.

## Features

- **Terminal** — spawns a shell (`node-pty`) so a browser `xterm` becomes a real
  terminal running `claude` in any repo.
- **Ask** — `claude -p "<prompt>"` for a clean chat answer (no API keys).
- **Vision** — send a screenshot; the bridge writes it to a temp file and has
  Claude Code read + describe it, then deletes it.
- **Zero cloud** — everything is local; nothing goes to a third party.

## Security (deliberate)

- Binds to **127.0.0.1 only** — unreachable from any other machine.
- Requires a **secret token** (auto-generated into `.env.local`, git-ignored).
- **Origin allowlist** blocks stray web pages / DNS-rebinding.
- **Workspace jail** — sessions can only open a direct child of the workspace root.

## Quick start

```bash
npm install      # ws (+ optional node-pty for the terminal)
npm start        # prints your token and listens on ws://127.0.0.1:7420
```

Paste the printed token into your web client, connect, and go. `node-pty` is
optional — chat and vision work without it (only the terminal needs it).

## Protocol (JSON over the socket)

| Client → | Bridge → |
| --- | --- |
| `{type:"start",workspace,cols,rows}` | `{type:"started"}` / `{type:"data"}` / `{type:"exit"}` |
| `{type:"stdin",data}` · `{type:"resize",cols,rows}` | — |
| `{type:"ask",id,prompt,workspace}` | `{type:"ask-chunk"}` → `{type:"ask-done"}` |
| `{type:"ask-image",id,prompt,image}` | `{type:"ask-chunk"}` → `{type:"ask-done"}` |

## Config (`.env.example`)

| Var | Default |
| --- | --- |
| `HUBOS_BRIDGE_PORT` | `7420` |
| `HUBOS_WORKSPACE_ROOT` | `E:\GitHub` (win) / `~/GitHub` |
| `HUBOS_ALLOWED_ORIGINS` | localhost + your app origin |

## License

MIT © Dinesh Parvatham
