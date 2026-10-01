#!/usr/bin/env node
/**
 * md-log — mirror a Claude Code teaching session into a Markdown file.
 *
 * Port of the pi `md-log` extension from github.com/amosblomqvist/learn.
 *
 * Long teaching sessions are hard to read in a terminal, and markdown/math don't render there. The
 * log is meant to be read rendered (Obsidian, or any Markdown reader), so assistant text with
 * $...$ math, ```mermaid blocks and ![[embeds]] all render natively — no rendering work here.
 *
 * Captures only reading-relevant content:
 *   - user prompts
 *   - assistant text (the lesson itself)
 *   - AskUserQuestion Q&A blocks (the quiz protocol)
 * Tool calls (Bash, Read, Write, ...), thinking blocks and background-task notifications are
 * omitted.
 *
 * Modes, all of which first catch up on the transcript, then append only what is new:
 *   - Stop hook                     — end of every assistant turn.
 *   - PreToolUse  (AskUserQuestion) — writes the question from tool_input the moment it is asked,
 *                                     so the learner can read it rendered while answering. The
 *                                     transcript does not contain the tool_use until later.
 *   - PostToolUse (AskUserQuestion) — writes the answer from tool_response.
 *   - `node md-log.mjs --note`      — appends Markdown from stdin. The transcript does NOT keep
 *                                     assistant text that precedes a tool call in the same
 *                                     message, so the teacher pipes such text (e.g. grading that
 *                                     leads into the next quiz) through this before asking.
 * AskUserQuestion blocks in the transcript are skipped; the Pre/Post hooks own them.
 *
 * Config + state live in .claude/learn.json (git-ignored; see .claude/learn.example.json):
 *   {
 *     "language":   "<what the teacher teaches in>",
 *     "topicsRoot": "<dir holding one folder per topic; absolute, or relative to the project>",
 *     "topic":      "<active topic slug, or null>",
 *     "labels":     { "user": "...", "question": "...", "answer": "..." },
 *     "sessions":   { "<session_id>": <transcript lines already consumed> },
 *     "lastTranscript": { "id": "<session_id>", "path": "<transcript path>" }
 *   }
 * The log is written to <topicsRoot>/<topic>/log.md. With no config or no active topic, this
 * hook is a no-op.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLAUDE_DIR = path.join(HERE, "..");
const PROJECT_DIR = path.join(CLAUDE_DIR, "..");
const CONFIG = path.join(CLAUDE_DIR, "learn.json");

const DEFAULT_LABELS = { user: "You", question: "Question", answer: "My answer" };

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

const noteMode = process.argv.includes("--note");
const stdin = readStdin();

let input = {};
if (!noteMode) {
  try {
    input = JSON.parse(stdin || "{}");
  } catch {
    process.exit(0);
  }
}

let cfg = null;
try {
  cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
} catch {
  process.exit(0); // not configured — nothing to do
}
if (!cfg || !cfg.topic) process.exit(0); // no active topic

const root = cfg.topicsRoot || "topics";
const topicDir = path.isAbsolute(root)
  ? path.join(root, cfg.topic)
  : path.join(PROJECT_DIR, root, cfg.topic);
const target = path.join(topicDir, "log.md");
const labels = { ...DEFAULT_LABELS, ...(cfg.labels || {}) };

cfg.sessions = cfg.sessions || {};
const transcript = noteMode ? cfg.lastTranscript?.path : input.transcript_path;
const sessionId = noteMode ? cfg.lastTranscript?.id || "unknown" : input.session_id || "unknown";
if (!noteMode && transcript) cfg.lastTranscript = { id: sessionId, path: transcript };

const out = [];

// ── rendering helpers ──────────────────────────────────────────────────────

const SKIP_USER_PREFIXES = [
  "<command-name>",
  "<local-command-stdout>",
  "<user-prompt-submit-hook>",
  "<task-notification>",
  "[SYSTEM NOTIFICATION",
  "[Request interrupted",
  "Caveat:",
];

function stripReminders(s) {
  return s
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "")
    .trim();
}

function renderQuestions(qs) {
  const parts = [];
  for (const q of qs || []) {
    parts.push(`\n#### ❓ ${q.header || labels.question}\n\n${q.question}\n`);
    for (const [n, o] of (q.options || []).entries()) {
      parts.push(`${n + 1}. **${o.label}**${o.description ? ` — ${o.description}` : ""}`);
    }
    parts.push("");
  }
  // Never write the correct answer here: the learner reads this file live.
  return parts.join("\n");
}

function renderAnswer(resp) {
  let body = "";
  if (typeof resp === "string") body = resp;
  else if (Array.isArray(resp))
    body = resp.filter((x) => x.type === "text").map((x) => x.text).join("\n");
  else if (resp && typeof resp.answers === "object")
    body = Object.entries(resp.answers).map(([q, a]) => `- ${q}\n  → **${a}**`).join("\n");
  else if (resp) body = JSON.stringify(resp);
  return `\n**${labels.answer}:**\n\n${body.trim()}\n`;
}

// ── catch up on the transcript ─────────────────────────────────────────────

function readLines() {
  if (!transcript || !fs.existsSync(transcript)) return [];
  try {
    return fs.readFileSync(transcript, "utf8").split(/\r?\n/).filter((l) => l.trim());
  } catch {
    return [];
  }
}

// Has the turn's closing assistant text reached the transcript yet? Look at the last entry that
// is a user or assistant message: done once it is assistant text.
function turnFlushed(ls) {
  for (let i = ls.length - 1; i >= 0; i--) {
    let e;
    try {
      e = JSON.parse(ls[i]);
    } catch {
      continue;
    }
    if (e.type !== "user" && e.type !== "assistant") continue;
    const c = e.message?.content;
    if (e.type === "user") return false;
    if (Array.isArray(c) && c.some((b) => b.type === "text")) return true;
    if (Array.isArray(c) && c.some((b) => b.type === "tool_use")) return false;
  }
  return true;
}

// Stop fires before Claude Code has written the final assistant message, so without waiting the
// last message of every turn would only show up one turn later.
let lines = readLines();
if (input.hook_event_name === "Stop") {
  for (let n = 0; n < 40 && !turnFlushed(lines); n++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    lines = readLines();
  }
}
const start = cfg.sessions[sessionId] || 0;
let consumed = start;

for (let i = start; i < lines.length; i++) {
  let e;
  try {
    e = JSON.parse(lines[i]);
  } catch {
    if (i === lines.length - 1) break; // partially written last line — retry next run
    consumed = i + 1;
    continue;
  }
  consumed = i + 1;
  const msg = e.message;
  if (!msg) continue;

  // --- user prompts (AskUserQuestion answers are written by the PostToolUse hook) ---
  if (e.type === "user") {
    const c = msg.content;
    if (typeof c === "string") {
      const raw = c.trim();
      if (SKIP_USER_PREFIXES.some((p) => raw.startsWith(p))) continue;
      const text = stripReminders(c);
      if (!text) continue;
      if (SKIP_USER_PREFIXES.some((p) => text.startsWith(p))) continue;
      out.push(`\n---\n\n### 🧑 ${labels.user}\n\n${text}\n`);
    } else if (Array.isArray(c) && !c.some((b) => b.type === "tool_result")) {
      // a prompt with attachments: text blocks plus pasted images
      const parts = [];
      for (const b of c) {
        if (b.type === "text") {
          const t = stripReminders(b.text || "").replace(/\[Image #\d+\]\s*/g, "");
          if (!t || t.startsWith("[Image: source:")) continue;
          if (SKIP_USER_PREFIXES.some((p) => t.startsWith(p))) continue;
          parts.push(t);
        } else if (b.type === "image" && b.source?.type === "base64") {
          const ext = (b.source.media_type || "image/png").split("/")[1] || "png";
          const name = `img-${String(e.uuid || i).slice(0, 8)}-${parts.length}.${ext}`;
          const dir = path.join(topicDir, "viz");
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, name), Buffer.from(b.source.data, "base64"));
          parts.push(`![[${name}]]`);
        }
      }
      if (parts.length) out.push(`\n---\n\n### 🧑 ${labels.user}\n\n${parts.join("\n\n")}\n`);
    }
    continue;
  }

  // --- assistant text (AskUserQuestion prompts are written by the PreToolUse hook) ---
  if (e.type === "assistant" && Array.isArray(msg.content)) {
    for (const b of msg.content) {
      if (b.type !== "text") continue;
      const t = (b.text || "").trim();
      if (t) out.push(`\n${t}\n`);
    }
  }
}
cfg.sessions[sessionId] = consumed;

// ── mode-specific additions ────────────────────────────────────────────────

if (noteMode) {
  const t = stdin.trim();
  if (t) out.push(`\n${t}\n`);
} else if (input.tool_name === "AskUserQuestion") {
  if (input.hook_event_name === "PreToolUse") {
    const r = renderQuestions(input.tool_input?.questions);
    if (r) out.push(r);
  } else if (input.hook_event_name === "PostToolUse") {
    out.push(renderAnswer(input.tool_response));
  }
}

if (out.length) {
  fs.mkdirSync(topicDir, { recursive: true });
  if (!fs.existsSync(target)) {
    fs.writeFileSync(target, `# ${cfg.topic}\n\n*${new Date().toISOString().slice(0, 10)}*\n`, "utf8");
  }
  fs.appendFileSync(target, out.join("\n"), "utf8");
}

fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + "\n", "utf8");
process.exit(0);
