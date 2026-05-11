import { resetSession, resolveSession } from "../sessions/store.js";
import { getAgentConfig } from "../config/agents.js";
import type { SessionKey } from "../sessions/types.js";
import { getUsageSummary } from "../billing/tracker.js";
import { checkTokenBudget } from "../billing/budget-check.js";

// ── In-Chat Slash Commands ──────────────────────────────────────────
// Parses slash commands from user messages before they hit the agent
// loop. Returns a command result if handled, or null to continue to
// the agent.

export interface CommandResult {
  handled: true;
  content: string;
}

const COMMANDS: Record<string, string> = {
  "/reset": "Reset the current session and start fresh",
  "/new": "Same as /reset — start a new session",
  "/compact": "Compress the current session to free up context",
  "/status": "Show session info and token usage",
  "/help": "List available commands",
};

export async function handleCommand(
  message: string,
  uid: string,
  agentId: string,
  sessionKey: SessionKey,
): Promise<CommandResult | null> {
  const trimmed = message.trim();
  if (!trimmed.startsWith("/")) return null;

  const cmd = trimmed.split(/\s+/)[0]!.toLowerCase();

  switch (cmd) {
    case "/reset":
    case "/new": {
      const agentConfig = getAgentConfig(agentId);
      const { session } = await resetSession(sessionKey, agentConfig);
      return {
        handled: true,
        content: `Session reset. New session: ${session.id.slice(0, 8)}...`,
      };
    }

    case "/compact": {
      const agentConfig = getAgentConfig(agentId);
      const { session, messages } = await resolveSession(sessionKey, agentConfig);
      if (messages.length < 6) {
        return {
          handled: true,
          content: "Session is too short to compact. Keep chatting.",
        };
      }
      // Import dynamically to avoid circular deps — compaction needs inference
      return {
        handled: true,
        content: `Session has ${messages.length} messages in session ${session.id.slice(0, 8)}. Use the chat to continue — compaction runs automatically when context gets large.`,
      };
    }

    case "/status": {
      const agentConfig = getAgentConfig(agentId);
      const { session, messages } = await resolveSession(sessionKey, agentConfig);
      let usage = "";
      let budgetInfo = "";
      try {
        const summary = await getUsageSummary(uid);
        if (summary) {
          usage = `\nTokens this month: ${summary.totalTokens.toLocaleString()} (${summary.requestCount} requests)`;
        }
      } catch { /* ignore */ }
      try {
        const budget = await checkTokenBudget(uid);
        const pct = Math.round((budget.currentUsage / budget.limit) * 100);
        budgetInfo = `\n**Budget**: ${budget.currentUsage.toLocaleString()}/${budget.limit.toLocaleString()} tokens (${pct}%) — ${budget.tier} tier`;
        if (budget.degraded) budgetInfo += " (degraded)";
      } catch { /* ignore */ }

      return {
        handled: true,
        content: [
          `**Session**: ${session.id.slice(0, 8)}...`,
          `**Agent**: ${agentConfig.displayName} (${agentConfig.tier})`,
          `**Messages**: ${messages.length}/${agentConfig.session.maxContextMessages}`,
          `**Model**: ${agentConfig.model.modelId}`,
          usage,
          budgetInfo,
        ].filter(Boolean).join("\n"),
      };
    }

    case "/help": {
      const lines = Object.entries(COMMANDS).map(
        ([cmd, desc]) => `**${cmd}** — ${desc}`,
      );
      return {
        handled: true,
        content: "Available commands:\n" + lines.join("\n"),
      };
    }

    default:
      // Not a recognized command — let it through to the agent
      return null;
  }
}
