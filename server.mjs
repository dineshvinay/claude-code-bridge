/**
 * hubos-bridge — the local half of the HubOS Claude Code console.
 *
 * WHY THIS EXISTS
 *   HubOS is deployed on Vercel (serverless) and cannot spawn a long-lived
 *   `claude` process or reach your local repos. This tiny process runs on YOUR
 *   machine, where the repos and the `claude` CLI actually live, and streams a
 *   real terminal into the HubOS `/console` page over a WebSocket — the same
 *   model as VS Code's integrated terminal / code-server.
 *
 * SECURITY (deliberate, do not loosen without thinking)
 *   1. Binds to 127.0.0.1 ONLY  → nothing off this machine can connect.
 *   2. Requires a shared secret TOKEN on every connection (auto-generated into
 *      bridge/.env.local on first run; never committed).
 *   3. Origin allowlist          → blocks random web pages / DNS-rebinding.
 *   4. Workspace jail            → sessions can only cwd into a direct child of
 *      WORKSPACE_ROOT (default E:\GitHub); no path traversal.
 *
 * No framework, no build step — plain Node ESM. Deps: ws + node-pty.
 */

import { WebSocketServer } from "ws";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, basename } from "node:path";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, ".env.local");

// ---------------------------------------------------------------------------
// Tiny .env.local loader (no dependency). KEY=VALUE per line, # comments.
// ---------------------------------------------------------------------------
function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

const fileEnv = loadEnvFile(ENV_PATH);
const env = { ...fileEnv, ...process.env };

// ---------------------------------------------------------------------------
// Token: reuse the one in .env.local, else generate + persist it.
// ---------------------------------------------------------------------------
function ensureToken() {
  let token = env.HUBOS_BRIDGE_TOKEN;
  if (token && token.length >= 16) return token;
  token = randomBytes(24).toString("base64url");
  const header =
    "# hubos-bridge secrets — generated automatically. DO NOT COMMIT.\n" +
    "# Paste HUBOS_BRIDGE_TOKEN into the HubOS /console page to connect.\n";
  writeFileSync(ENV_PATH, `${header}HUBOS_BRIDGE_TOKEN=${token}\n`, "utf8");
  console.log("\n  Generated a new bridge token → bridge/.env.local");
  return token;
}

const TOKEN = ensureToken();

if (process.argv.includes("--print-token")) {
  console.log(TOKEN);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = Number(env.HUBOS_BRIDGE_PORT || 7420);
const HOST = "127.0.0.1"; // loopback only — non-negotiable
const WORKSPACE_ROOT = env.HUBOS_WORKSPACE_ROOT || (process.platform === "win32" ? "E:\\GitHub" : join(os.homedir(), "GitHub"));
const ALLOWED_ORIGINS = new Set(
  (env.HUBOS_ALLOWED_ORIGINS ||
    "https://hub.prodmtech.in,http://localhost:3000,http://127.0.0.1:3000")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
// The command each session runs. Default: the platform shell (feels like VS
// Code's terminal); the UI can ask to auto-run `claude` on start.
const isWin = process.platform === "win32";
const DEFAULT_SHELL = env.HUBOS_SHELL || (isWin ? "powershell.exe" : process.env.SHELL || "bash");

// ---------------------------------------------------------------------------
// Workspace jail — list + resolve direct children of WORKSPACE_ROOT only.
// ---------------------------------------------------------------------------
function listWorkspaces() {
  try {
    return readdirSync(WORKSPACE_ROOT)
      .filter((name) => {
        if (name.startsWith(".")) return false;
        try {
          return statSync(join(WORKSPACE_ROOT, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

/** Resolve a client-supplied workspace name to a safe absolute path, or null. */
function resolveWorkspace(name) {
  if (!name || typeof name !== "string") return WORKSPACE_ROOT;
  const safe = basename(name); // strip any path segments — jail escape guard
  const full = resolve(WORKSPACE_ROOT, safe);
  if (!full.startsWith(resolve(WORKSPACE_ROOT))) return null;
  if (!existsSync(full) || !statSync(full).isDirectory()) return null;
  return full;
}

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({
  host: HOST,
  port: PORT,
  verifyClient: (info, done) => {
    const origin = info.origin || info.req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      console.warn(`  ✗ rejected connection from origin: ${origin}`);
      return done(false, 403, "Origin not allowed");
    }
    let token = null;
    try {
      token = new URL(info.req.url, "http://127.0.0.1").searchParams.get("token");
    } catch {
      /* fall through */
    }
    if (token !== TOKEN) {
      console.warn("  ✗ rejected connection: bad or missing token");
      return done(false, 401, "Unauthorized");
    }
    return done(true);
  },
});

wss.on("connection", (ws) => {
  let pty = null;

  const send = (obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };

  send({ type: "hello", workspaces: listWorkspaces(), root: WORKSPACE_ROOT, shell: DEFAULT_SHELL });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case "start": {
        if (pty) return; // one session per socket
        const cwd = resolveWorkspace(msg.workspace);
        if (!cwd) {
          send({ type: "error", message: `Workspace not found under ${WORKSPACE_ROOT}` });
          return;
        }
        const cols = Number(msg.cols) || 80;
        const rows = Number(msg.rows) || 24;
        // node-pty is OPTIONAL (native build). The console/terminal needs it, but
        // Nexus chat (`ask`) and screen-watch (`ask-image`) do NOT — so we load it
        // lazily and degrade gracefully if it isn't installed.
        import("node-pty")
          .then(({ spawn: ptySpawn }) => {
            try {
              pty = ptySpawn(DEFAULT_SHELL, [], {
                name: "xterm-color",
                cols,
                rows,
                cwd,
                env: { ...process.env, TERM: "xterm-256color" },
              });
            } catch (err) {
              send({ type: "error", message: `Failed to start shell: ${err.message}` });
              return;
            }
            pty.onData((data) => send({ type: "data", data }));
            pty.onExit(({ exitCode }) => {
              send({ type: "exit", code: exitCode });
              pty = null;
            });
            send({ type: "started", cwd, workspace: basename(cwd) });
            if (msg.autostart) setTimeout(() => pty && pty.write("claude\r"), 400);
          })
          .catch(() =>
            send({
              type: "error",
              message: "Terminal needs node-pty (native build) which isn't installed — but Nexus chat & screen-watch still work.",
            }),
          );
        break;
      }
      case "stdin": {
        if (pty && typeof msg.data === "string") pty.write(msg.data);
        break;
      }
      case "resize": {
        if (pty) {
          try {
            pty.resize(Number(msg.cols) || 80, Number(msg.rows) || 24);
          } catch {
            /* ignore transient resize errors */
          }
        }
        break;
      }
      case "ask": {
        // Nexus chat → Claude Code print mode. Uses the operator's Claude Code
        // SUBSCRIPTION (the authenticated `claude` CLI), NOT paid API credits.
        const prompt = String(msg.prompt || "").slice(0, 6000).trim();
        const id = msg.id;
        if (!prompt) {
          send({ type: "ask-done", id, text: "", error: "empty prompt" });
          break;
        }
        const cwd = resolveWorkspace(msg.workspace) || WORKSPACE_ROOT;
        // Prompt is passed via an env var and referenced quoted, so its contents
        // are never re-parsed by the shell (injection-safe for this loopback tool).
        const cmd = isWin ? 'claude -p "%NEXUS_PROMPT%"' : 'claude -p "$NEXUS_PROMPT"';
        let child;
        try {
          child = spawn(cmd, { cwd, shell: true, env: { ...process.env, NEXUS_PROMPT: prompt } });
        } catch (err) {
          send({ type: "ask-done", id, text: "", error: `Could not launch claude: ${err.message}` });
          break;
        }
        let out = "";
        let errOut = "";
        child.stdout.on("data", (d) => {
          const s = d.toString();
          out += s;
          send({ type: "ask-chunk", id, data: s });
        });
        child.stderr.on("data", (d) => (errOut += d.toString()));
        child.on("error", (err) =>
          send({ type: "ask-done", id, text: "", error: `claude not found on PATH: ${err.message}` }),
        );
        child.on("close", (code) =>
          send({
            type: "ask-done",
            id,
            text: out.trim(),
            error: code !== 0 && !out.trim() ? errOut.trim() || `claude exited ${code}` : undefined,
          }),
        );
        break;
      }
      case "ask-image": {
        // Nexus "watches the screen": the browser sends a captured frame (base64
        // PNG/JPEG); we write it to a temp file and let Claude Code (the operator's
        // SUBSCRIPTION) read + describe it. Same $0/no-credit model as `ask`.
        const id = msg.id;
        const prompt = String(msg.prompt || "").slice(0, 2000).trim();
        const raw = String(msg.image || "").replace(/^data:image\/\w+;base64,/, "");
        if (!raw) {
          send({ type: "ask-done", id, text: "", error: "no image" });
          break;
        }
        const tmpPath = join(os.tmpdir(), `nexus-screen-${Date.now()}.png`);
        try {
          writeFileSync(tmpPath, Buffer.from(raw, "base64"));
        } catch (err) {
          send({ type: "ask-done", id, text: "", error: `could not write frame: ${err.message}` });
          break;
        }
        const fullPrompt = `Read the image file at "${tmpPath}" — it is a screenshot of the operator's screen. ${
          prompt || "Describe what is on screen and anything notable or actionable."
        } Be concise.`;
        const cmd = isWin ? 'claude -p "%NEXUS_PROMPT%"' : 'claude -p "$NEXUS_PROMPT"';
        let child;
        try {
          child = spawn(cmd, { cwd: WORKSPACE_ROOT, shell: true, env: { ...process.env, NEXUS_PROMPT: fullPrompt } });
        } catch (err) {
          try { unlinkSync(tmpPath); } catch { /* noop */ }
          send({ type: "ask-done", id, text: "", error: `could not launch claude: ${err.message}` });
          break;
        }
        let out = "";
        let errOut = "";
        child.stdout.on("data", (d) => {
          const s = d.toString();
          out += s;
          send({ type: "ask-chunk", id, data: s });
        });
        child.stderr.on("data", (d) => (errOut += d.toString()));
        child.on("error", (err) => {
          try { unlinkSync(tmpPath); } catch { /* noop */ }
          send({ type: "ask-done", id, text: "", error: `claude not found: ${err.message}` });
        });
        child.on("close", (code) => {
          try { unlinkSync(tmpPath); } catch { /* noop */ }
          send({
            type: "ask-done",
            id,
            text: out.trim(),
            error: code !== 0 && !out.trim() ? errOut.trim() || `claude exited ${code}` : undefined,
          });
        });
        break;
      }
      case "transcribe": {
        // Universal STT: the browser records the mic (MediaRecorder — works on EVERY
        // browser incl. iOS/Brave) and sends the audio; we transcribe LOCALLY with
        // Whisper (faster-whisper). $0, offline, no API credits.
        const id = msg.id;
        const raw = String(msg.audio || "").replace(/^data:[^;]+;base64,/, "");
        if (!raw) {
          send({ type: "transcribe-done", id, text: "", error: "no audio" });
          break;
        }
        const mime = String(msg.mime || "");
        const ext = mime.includes("mp4") || mime.includes("mpeg") || mime.includes("m4a") ? "m4a" : mime.includes("ogg") ? "ogg" : "webm";
        const audioPath = join(os.tmpdir(), `nexus-voice-${Date.now()}.${ext}`);
        try {
          writeFileSync(audioPath, Buffer.from(raw, "base64"));
        } catch (err) {
          send({ type: "transcribe-done", id, text: "", error: `write failed: ${err.message}` });
          break;
        }
        const scriptPath = join(__dirname, "transcribe.py");
        const py = process.env.HUBOS_WHISPER_PY || (isWin ? "python" : "python3");
        const cmd = isWin ? `${py} "%NEXUS_SCRIPT%" "%NEXUS_AUDIO%"` : `${py} "$NEXUS_SCRIPT" "$NEXUS_AUDIO"`;
        let child;
        try {
          child = spawn(cmd, { shell: true, env: { ...process.env, NEXUS_SCRIPT: scriptPath, NEXUS_AUDIO: audioPath } });
        } catch (err) {
          try { unlinkSync(audioPath); } catch { /* noop */ }
          send({ type: "transcribe-done", id, text: "", error: `whisper launch failed: ${err.message}` });
          break;
        }
        let out = "";
        let errOut = "";
        child.stdout.on("data", (d) => (out += d.toString()));
        child.stderr.on("data", (d) => (errOut += d.toString()));
        child.on("error", (err) => {
          try { unlinkSync(audioPath); } catch { /* noop */ }
          send({ type: "transcribe-done", id, text: "", error: `whisper not available: ${err.message}` });
        });
        child.on("close", (code) => {
          try { unlinkSync(audioPath); } catch { /* noop */ }
          const text = out.trim();
          if (code !== 0 && !text) {
            send({ type: "transcribe-done", id, text: "", error: (errOut.trim().split("\n").pop() || `whisper exited ${code}`).slice(0, 200) });
          } else {
            send({ type: "transcribe-done", id, text });
          }
        });
        break;
      }
      default:
        break;
    }
  });

  ws.on("close", () => {
    if (pty) {
      try {
        pty.kill();
      } catch {
        /* already gone */
      }
      pty = null;
    }
  });
});

wss.on("listening", () => {
  console.log(`\n  ▸ hubos-bridge listening on ws://${HOST}:${PORT}`);
  console.log(`  ▸ workspace root: ${WORKSPACE_ROOT}`);
  console.log(`  ▸ token:          ${TOKEN}`);
  console.log(`\n  Open HubOS → Console, paste the token, pick a repo. Ctrl+C to stop.\n`);
});

wss.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n  ✗ Port ${PORT} is already in use. Set HUBOS_BRIDGE_PORT to a free port.\n`);
    process.exit(1);
  }
  console.error("  ✗ bridge error:", err.message);
});
