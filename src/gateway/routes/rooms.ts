import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { WorkspaceAwareRequest } from "../middleware/workspace.js";
import { createRoom, joinRoom, leaveRoom, getRoomMembers, getRoom } from "../../sessions/rooms.js";

const CreateRoomBody = z.object({
  sessionId: z.string().min(1),
});

export function createRoomsRouter(): Router {
  const router = Router();

  // POST /rooms — create a new room
  router.post("/", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const uid = (req as any).user?.uid as string | undefined;
    if (!uid) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const parsed = CreateRoomBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    try {
      const roomId = await createRoom(parsed.data.sessionId, uid, workspaceId);
      res.status(201).json({ id: roomId });
    } catch (err) {
      console.error("[rooms] Create:", err);
      res.status(500).json({ error: "Failed to create room" });
    }
  });

  // GET /rooms/:id — get room details with members
  router.get("/:id", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    try {
      const room = await getRoom(req.params["id"] as string, workspaceId);
      if (!room) {
        res.status(404).json({ error: "Room not found" });
        return;
      }
      const members = await getRoomMembers(room.id);
      res.json({ room: { ...room, members } });
    } catch (err) {
      console.error("[rooms] Get:", err);
      res.status(500).json({ error: "Failed to get room" });
    }
  });

  // POST /rooms/:id/join — join a room
  router.post("/:id/join", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const uid = (req as any).user?.uid as string | undefined;
    if (!uid) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    try {
      // Verify room belongs to workspace
      const room = await getRoom(req.params["id"] as string, workspaceId);
      if (!room) {
        res.status(404).json({ error: "Room not found" });
        return;
      }
      await joinRoom(room.id, uid);
      res.json({ message: "Joined room" });
    } catch (err) {
      console.error("[rooms] Join:", err);
      res.status(500).json({ error: "Failed to join room" });
    }
  });

  // DELETE /rooms/:id/leave — leave a room
  router.delete("/:id/leave", async (req: Request, res: Response) => {
    const workspace = (req as WorkspaceAwareRequest).workspace;
    const workspaceId = workspace?.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace required" });
      return;
    }

    const uid = (req as any).user?.uid as string | undefined;
    if (!uid) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    try {
      // Verify room belongs to workspace
      const room = await getRoom(req.params["id"] as string, workspaceId);
      if (!room) {
        res.status(404).json({ error: "Room not found" });
        return;
      }
      await leaveRoom(room.id, uid);
      res.json({ message: "Left room" });
    } catch (err) {
      console.error("[rooms] Leave:", err);
      res.status(500).json({ error: "Failed to leave room" });
    }
  });

  return router;
}
