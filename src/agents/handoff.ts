// Handoff Protocol — detects [HANDOFF: agentId] signals in responses.
// The actual handoff is triggered by the bus event, handled at the session level.

export interface HandoffSignal {
  targetAgentId: string;
  summary: string;
}

export function detectHandoffSignal(content: string): HandoffSignal | null {
  const match = content.match(/\[HANDOFF:\s*([^\]]+)\]/);
  if (!match) return null;
  return {
    targetAgentId: match[1]!.trim(),
    summary: content.replace(/\[HANDOFF:[^\]]*\]/g, "").trim().slice(0, 500),
  };
}
