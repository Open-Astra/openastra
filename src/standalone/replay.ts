import { getPool } from "../config/postgres.js";

// ── Session Replay ─────────────────────────────────────────────────
// `astra replay <session-id>` — replays a session's events step-by-step
// in the terminal with timing, tool calls, and agent handoffs.
// Useful for debugging production issues without the dashboard.

const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
interface SessionMessage {
  id: string;
  role: string;
  content: string;
  agent_id?: string;
  tool_name?: string;
  tool_args?: string;
  tool_result?: string;
  created_at: string;
  token_count?: number;
}

interface SessionInfo {
  id: string;
  agent_id: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  total_tokens: number;
}

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}

function roleColor(role: string): string {
  switch (role) {
    case "user": return CYAN;
    case "assistant": return GREEN;
    case "tool": return YELLOW;
    case "system": return DIM;
    default: return RESET;
  }
}

function roleIcon(role: string): string {
  switch (role) {
    case "user": return "👤";
    case "assistant": return "🤖";
    case "tool": return "🔧";
    case "system": return "⚙️";
    default: return "  ";
  }
}

export async function runReplay(): Promise<void> {
  const args = process.argv.slice(2).filter((a: string) => a !== "replay");
  const sessionId = args[0];
  const speed = parseFloat(args.find((a: string) => a.startsWith("--speed="))?.split("=")[1] ?? "1");
  const noDelay = args.includes("--no-delay");

  if (!sessionId) {
    printUsage();
    process.exit(1);
  }

  const pool = getPool();

  // Fetch session info
  const sessionResult = await pool.query<SessionInfo>(`
    SELECT s.id, s.agent_id, s.created_at, s.updated_at,
           COUNT(m.id)::int AS message_count,
           COALESCE(SUM(m.token_count), 0)::int AS total_tokens
    FROM sessions s
    LEFT JOIN session_messages m ON m.session_id = s.id
    WHERE s.id = $1
    GROUP BY s.id
  `, [sessionId]);

  if (sessionResult.rows.length === 0) {
    console.log(`${RED}Session not found: ${sessionId}${RESET}`);
    console.log(`${DIM}Run 'astra replay --list' to see recent sessions${RESET}`);
    process.exit(1);
  }

  const session = sessionResult.rows[0]!;

  // Fetch messages
  const messageResult = await pool.query<SessionMessage>(`
    SELECT id, role, content, agent_id, tool_name, tool_args, tool_result,
           created_at, token_count
    FROM session_messages
    WHERE session_id = $1
    ORDER BY created_at ASC
  `, [sessionId]);

  const messages = messageResult.rows;

  // Print header
  console.log(`\n${BOLD}  Session Replay${RESET}`);
  console.log(`${DIM}  ─────────────────────────────────────────${RESET}`);
  console.log(`  ${DIM}Session:${RESET}  ${session.id}`);
  console.log(`  ${DIM}Agent:${RESET}    ${session.agent_id}`);
  console.log(`  ${DIM}Started:${RESET}  ${new Date(session.created_at).toLocaleString()}`);
  console.log(`  ${DIM}Messages:${RESET} ${session.message_count}`);
  console.log(`  ${DIM}Tokens:${RESET}   ${session.total_tokens.toLocaleString()}`);
  console.log(`  ${DIM}Speed:${RESET}    ${noDelay ? "instant" : `${speed}x`}`);
  console.log(`${DIM}  ─────────────────────────────────────────${RESET}\n`);

  // Replay messages with timing
  let prevTimestamp: Date | null = null;

  for (const msg of messages) {
    const ts = new Date(msg.created_at);

    // Simulate timing gap between messages
    if (!noDelay && prevTimestamp) {
      const gap = ts.getTime() - prevTimestamp.getTime();
      const delay = Math.min(gap / speed, 3000); // Cap at 3s
      if (delay > 100) {
        await sleep(delay);
      }
    }
    prevTimestamp = ts;

    const color = roleColor(msg.role);
    const icon = roleIcon(msg.role);
    const time = formatTimestamp(msg.created_at);
    const agent = msg.agent_id ? ` ${DIM}[${msg.agent_id}]${RESET}` : "";
    const tokens = msg.token_count ? ` ${DIM}(${msg.token_count} tok)${RESET}` : "";

    // Tool call
    if (msg.role === "tool" || msg.tool_name) {
      console.log(`${DIM}${time}${RESET} ${icon} ${YELLOW}${msg.tool_name ?? "tool"}${RESET}${agent}${tokens}`);
      if (msg.tool_args) {
        console.log(`       ${DIM}args: ${truncate(msg.tool_args, 120)}${RESET}`);
      }
      if (msg.tool_result) {
        console.log(`       ${DIM}result: ${truncate(msg.tool_result, 120)}${RESET}`);
      }
      if (msg.content && msg.content !== msg.tool_result) {
        console.log(`       ${truncate(msg.content, 200)}`);
      }
    } else {
      // Regular message
      console.log(`${DIM}${time}${RESET} ${icon} ${color}${msg.role}${RESET}${agent}${tokens}`);
      if (msg.content) {
        const lines = msg.content.split("\n").slice(0, 10);
        for (const line of lines) {
          console.log(`       ${truncate(line, 120)}`);
        }
        if (msg.content.split("\n").length > 10) {
          console.log(`       ${DIM}... (${msg.content.split("\n").length - 10} more lines)${RESET}`);
        }
      }
    }
    console.log();
  }

  // Duration summary
  if (messages.length >= 2) {
    const first = new Date(messages[0]!.created_at).getTime();
    const last = new Date(messages[messages.length - 1]!.created_at).getTime();
    console.log(`${DIM}  ─────────────────────────────────────────${RESET}`);
    console.log(`  ${DIM}Duration:${RESET} ${formatDuration(last - first)}`);
    console.log(`  ${DIM}Messages:${RESET} ${messages.length}`);
    console.log(`  ${DIM}Tokens:${RESET}   ${session.total_tokens.toLocaleString()}`);
  }

  console.log();
  process.exit(0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function printUsage(): void {
  const BOLD = "\x1b[1m";
  const RESET = "\x1b[0m";
  const CYAN = "\x1b[36m";
  const DIM = "\x1b[2m";

  console.log(`
${BOLD}Usage:${RESET}
  npx astra replay <session-id> [options]

${BOLD}Options:${RESET}
  ${CYAN}--speed=N${RESET}    Playback speed multiplier (default: 1)
  ${CYAN}--no-delay${RESET}   Instant playback, no timing simulation

${BOLD}Examples:${RESET}
  ${DIM}$${RESET} npx astra replay abc123
  ${DIM}$${RESET} npx astra replay abc123 --speed=5
  ${DIM}$${RESET} npx astra replay abc123 --no-delay
`);
}
