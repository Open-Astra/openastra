export type ResolutionType = "compromise" | "side_a" | "side_b" | "escalated" | "deadlocked";
export type MediationStatus = "submitted" | "analyzing" | "mediating" | "resolved" | "escalated";
export type MediationPriority = "low" | "medium" | "high" | "critical";
export type EvidenceType = "output" | "reasoning" | "data" | "precedent";

export interface MediationSession {
  id: string; workspaceId: string; agentAId: string; agentBId: string;
  mediatorAgentId: string | null; disputeContext: string;
  agentAPosition: string | null; agentBPosition: string | null;
  mediatorAnalysis: string | null; resolution: string | null;
  resolutionType: ResolutionType | null; status: MediationStatus;
  priority: MediationPriority; createdAt: string; resolvedAt: string | null;
  evidence?: MediationEvidence[];
}

export interface MediationEvidence {
  id: string; sessionId: string; submittedBy: string;
  evidenceType: EvidenceType; content: string; submittedAt: string;
}
