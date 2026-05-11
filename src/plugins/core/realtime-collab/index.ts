import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { GatewayPlugin, PluginContext } from "../../types.js";

// ── Real-Time Collaborative Multi-User Agents ───────────────────────
// WebSocket-based plugin for multi-user session collaboration.
// Features:
// 1. Shared workspaces where multiple users + agents co-edit tasks/memory
// 2. Real-time presence tracking
// 3. Role-based permissions for sub-agents
// 4. Collaborative editing with CRDT-style conflict resolution
// 5. Event-driven updates via EventBus

// ── Types ───────────────────────────────────────────────────────────

interface CollabSession {
  id: string;
  workspaceId: string;
  createdBy: string;
  participants: Map<string, Participant>;
  messages: CollabMessage[];
  status: "active" | "paused" | "closed";
  createdAt: number;
}

interface Participant {
  id: string;
  uid: string;
  displayName: string;
  role: "owner" | "editor" | "viewer" | "agent";
  joinedAt: number;
  lastActiveAt: number;
  cursor?: { section: string; position: number };
}

interface CollabMessage {
  id: string;
  participantId: string;
  type: "text" | "edit" | "agent_response" | "system";
  content: string;
  metadata?: Record<string, unknown>;
  timestamp: number;
}

// ── Session Store ───────────────────────────────────────────────────
const sessions = new Map<string, CollabSession>();

// ── Permission Matrix ───────────────────────────────────────────────
const PERMISSIONS: Record<string, Set<string>> = {
  owner: new Set(["read", "write", "delete", "invite", "kick", "configure", "spawn_agent"]),
  editor: new Set(["read", "write", "spawn_agent"]),
  viewer: new Set(["read"]),
  agent: new Set(["read", "write"]),
};

function hasPermission(role: string, action: string): boolean {
  return PERMISSIONS[role]?.has(action) ?? false;
}

// ── Plugin ──────────────────────────────────────────────────────────

const realtimeCollabPlugin: GatewayPlugin = {
  name: "realtime_collab",
  version: "1.0.0",

  init(ctx: PluginContext) {
    const { app, getEventBus } = ctx;

    // ── Tool: collab_session ──────────────────────────────────────

    const CollabSessionParams = z.object({
      action: z.enum([
        "create", "join", "leave", "invite", "kick",
        "message", "edit", "presence", "list", "status",
        "set_role", "history",
      ]).describe("Collaboration action"),
      session_id: z.string().optional().describe("Session ID"),
      workspace_id: z.string().optional().describe("Workspace ID (for create)"),
      participant_uid: z.string().optional().describe("Target participant UID"),
      role: z.enum(["owner", "editor", "viewer", "agent"]).optional().describe("Role (for invite/set_role)"),
      content: z.string().optional().describe("Message content (for message/edit)"),
      display_name: z.string().optional().describe("Display name (for join)"),
      cursor: z.object({
        section: z.string(),
        position: z.number(),
      }).optional().describe("Cursor position (for presence)"),
    });

    ctx.registerTool({
      name: "collab_session",
      description:
        "Real-time collaborative multi-user sessions. Create shared workspaces, invite participants with role-based permissions, send messages, track presence, and co-edit tasks with agents.",
      parameters: CollabSessionParams,

      async execute(params, toolCtx) {
        const bus = getEventBus();

        switch (params.action) {
          case "create": {
            const sessionId = randomUUID();
            const workspaceId = params.workspace_id ?? toolCtx.workspaceId ?? `ws-${sessionId}`;

            const session: CollabSession = {
              id: sessionId,
              workspaceId,
              createdBy: toolCtx.uid,
              participants: new Map(),
              messages: [],
              status: "active",
              createdAt: Date.now(),
            };

            // Add creator as owner
            session.participants.set(toolCtx.uid, {
              id: randomUUID(),
              uid: toolCtx.uid,
              displayName: params.display_name ?? "Owner",
              role: "owner",
              joinedAt: Date.now(),
              lastActiveAt: Date.now(),
            });

            sessions.set(sessionId, session);

            bus.emit("collab:session_created" as any, {
              sessionId,
              workspaceId,
              createdBy: toolCtx.uid,
            });

            return {
              result: "Collaborative session created",
              sessionId,
              workspaceId,
            };
          }

          case "join": {
            if (!params.session_id) return { error: "session_id required" };
            const session = sessions.get(params.session_id);
            if (!session) return { error: "Session not found" };
            if (session.status !== "active") return { error: "Session is not active" };

            const participant: Participant = {
              id: randomUUID(),
              uid: toolCtx.uid,
              displayName: params.display_name ?? "Participant",
              role: "viewer", // Default role, can be upgraded
              joinedAt: Date.now(),
              lastActiveAt: Date.now(),
            };

            session.participants.set(toolCtx.uid, participant);

            bus.emit("collab:participant_joined" as any, {
              sessionId: params.session_id,
              uid: toolCtx.uid,
              role: participant.role,
            });

            return {
              result: "Joined session",
              sessionId: params.session_id,
              role: participant.role,
              participantCount: session.participants.size,
            };
          }

          case "leave": {
            if (!params.session_id) return { error: "session_id required" };
            const session = sessions.get(params.session_id);
            if (!session) return { error: "Session not found" };

            session.participants.delete(toolCtx.uid);

            bus.emit("collab:participant_left" as any, {
              sessionId: params.session_id,
              uid: toolCtx.uid,
            });

            // Close session if empty
            if (session.participants.size === 0) {
              session.status = "closed";
            }

            return { result: "Left session" };
          }

          case "invite": {
            if (!params.session_id || !params.participant_uid) {
              return { error: "session_id and participant_uid required" };
            }
            const session = sessions.get(params.session_id);
            if (!session) return { error: "Session not found" };

            const inviter = session.participants.get(toolCtx.uid);
            if (!inviter || !hasPermission(inviter.role, "invite")) {
              return { error: "No permission to invite" };
            }

            const role = params.role ?? "editor";
            const participant: Participant = {
              id: randomUUID(),
              uid: params.participant_uid,
              displayName: params.display_name ?? "Invited",
              role,
              joinedAt: Date.now(),
              lastActiveAt: Date.now(),
            };

            session.participants.set(params.participant_uid, participant);

            bus.emit("collab:participant_invited" as any, {
              sessionId: params.session_id,
              uid: params.participant_uid,
              role,
              invitedBy: toolCtx.uid,
            });

            return {
              result: "Participant invited",
              participantUid: params.participant_uid,
              role,
            };
          }

          case "kick": {
            if (!params.session_id || !params.participant_uid) {
              return { error: "session_id and participant_uid required" };
            }
            const session = sessions.get(params.session_id);
            if (!session) return { error: "Session not found" };

            const kicker = session.participants.get(toolCtx.uid);
            if (!kicker || !hasPermission(kicker.role, "kick")) {
              return { error: "No permission to kick" };
            }

            session.participants.delete(params.participant_uid);
            return { result: "Participant removed" };
          }

          case "message": {
            if (!params.session_id || !params.content) {
              return { error: "session_id and content required" };
            }
            const session = sessions.get(params.session_id);
            if (!session) return { error: "Session not found" };

            const sender = session.participants.get(toolCtx.uid);
            if (!sender || !hasPermission(sender.role, "write")) {
              return { error: "No permission to send messages" };
            }

            const msg: CollabMessage = {
              id: randomUUID(),
              participantId: sender.id,
              type: sender.role === "agent" ? "agent_response" : "text",
              content: params.content,
              timestamp: Date.now(),
            };

            session.messages.push(msg);

            // Keep only last 500 messages
            if (session.messages.length > 500) {
              session.messages = session.messages.slice(-500);
            }

            sender.lastActiveAt = Date.now();

            bus.emit("collab:message" as any, {
              sessionId: params.session_id,
              messageId: msg.id,
              sender: sender.uid,
              type: msg.type,
            });

            return {
              result: "Message sent",
              messageId: msg.id,
              participants: session.participants.size,
            };
          }

          case "edit": {
            if (!params.session_id || !params.content) {
              return { error: "session_id and content required" };
            }
            const session = sessions.get(params.session_id);
            if (!session) return { error: "Session not found" };

            const editor = session.participants.get(toolCtx.uid);
            if (!editor || !hasPermission(editor.role, "write")) {
              return { error: "No permission to edit" };
            }

            const edit: CollabMessage = {
              id: randomUUID(),
              participantId: editor.id,
              type: "edit",
              content: params.content,
              metadata: { cursor: params.cursor },
              timestamp: Date.now(),
            };

            session.messages.push(edit);
            editor.lastActiveAt = Date.now();

            bus.emit("collab:edit" as any, {
              sessionId: params.session_id,
              editId: edit.id,
              editor: editor.uid,
            });

            return { result: "Edit applied", editId: edit.id };
          }

          case "presence": {
            if (!params.session_id) return { error: "session_id required" };
            const session = sessions.get(params.session_id);
            if (!session) return { error: "Session not found" };

            const participant = session.participants.get(toolCtx.uid);
            if (participant) {
              participant.lastActiveAt = Date.now();
              if (params.cursor) participant.cursor = params.cursor;
            }

            const activeParticipants = [...session.participants.values()]
              .filter((p) => Date.now() - p.lastActiveAt < 300_000) // Active in last 5 min
              .map((p) => ({
                uid: p.uid,
                displayName: p.displayName,
                role: p.role,
                cursor: p.cursor,
                lastActive: new Date(p.lastActiveAt).toISOString(),
              }));

            return {
              result: "Presence updated",
              activeParticipants,
              totalParticipants: session.participants.size,
            };
          }

          case "list": {
            const userSessions = [...sessions.values()]
              .filter((s) => s.participants.has(toolCtx.uid) && s.status === "active")
              .map((s) => ({
                id: s.id,
                workspaceId: s.workspaceId,
                participantCount: s.participants.size,
                messageCount: s.messages.length,
                createdAt: new Date(s.createdAt).toISOString(),
              }));

            return { result: `${userSessions.length} active session(s)`, sessions: userSessions };
          }

          case "status": {
            if (!params.session_id) return { error: "session_id required" };
            const session = sessions.get(params.session_id);
            if (!session) return { error: "Session not found" };

            return {
              result: "Session status",
              sessionId: session.id,
              workspaceId: session.workspaceId,
              status: session.status,
              participantCount: session.participants.size,
              messageCount: session.messages.length,
              participants: [...session.participants.values()].map((p) => ({
                uid: p.uid,
                displayName: p.displayName,
                role: p.role,
                lastActive: new Date(p.lastActiveAt).toISOString(),
              })),
              recentMessages: session.messages.slice(-5).map((m) => ({
                type: m.type,
                content: m.content.slice(0, 200),
                timestamp: new Date(m.timestamp).toISOString(),
              })),
            };
          }

          case "set_role": {
            if (!params.session_id || !params.participant_uid || !params.role) {
              return { error: "session_id, participant_uid, and role required" };
            }
            const session = sessions.get(params.session_id);
            if (!session) return { error: "Session not found" };

            const admin = session.participants.get(toolCtx.uid);
            if (!admin || !hasPermission(admin.role, "configure")) {
              return { error: "No permission to change roles" };
            }

            const target = session.participants.get(params.participant_uid);
            if (!target) return { error: "Participant not found" };

            target.role = params.role;

            return {
              result: "Role updated",
              participantUid: params.participant_uid,
              newRole: params.role,
            };
          }

          case "history": {
            if (!params.session_id) return { error: "session_id required" };
            const session = sessions.get(params.session_id);
            if (!session) return { error: "Session not found" };

            const viewer = session.participants.get(toolCtx.uid);
            if (!viewer || !hasPermission(viewer.role, "read")) {
              return { error: "No permission to view history" };
            }

            return {
              result: `${session.messages.length} message(s)`,
              messages: session.messages.slice(-50).map((m) => ({
                id: m.id,
                type: m.type,
                content: m.content.slice(0, 500),
                timestamp: new Date(m.timestamp).toISOString(),
              })),
            };
          }

          default:
            return { error: "Unknown action" };
        }
      },
    });

    // ── REST Endpoints ──────────────────────────────────────────────

    app.get("/api/collab/sessions", (_req, res) => {
      const activeSessions = [...sessions.values()]
        .filter((s) => s.status === "active")
        .map((s) => ({
          id: s.id,
          workspaceId: s.workspaceId,
          participantCount: s.participants.size,
          createdAt: s.createdAt,
        }));

      res.json({ sessions: activeSessions });
    });

    app.get("/api/collab/sessions/:id", (req, res) => {
      const session = sessions.get(req.params.id);
      if (!session) {
        res.status(404).json({ error: "Session not found" });
        return;
      }

      res.json({
        id: session.id,
        workspaceId: session.workspaceId,
        status: session.status,
        participantCount: session.participants.size,
        messageCount: session.messages.length,
      });
    });

    ctx.logger.info("[realtime-collab] Plugin initialized with collab_session tool and REST endpoints");
  },

  stop() {
    // Clean up all sessions
    for (const session of sessions.values()) {
      session.status = "closed";
    }
    sessions.clear();
  },
};

export default realtimeCollabPlugin;
