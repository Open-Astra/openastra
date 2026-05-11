import { z } from "zod";
import { registerTool } from "./registry.js";
import { getPool } from "../config/postgres.js";

const Params = z.object({
  taskId: z.string().uuid(),
});

registerTool({
  name: "tool_poll",
  description: "Poll the status of a previously started async tool execution. Returns status (pending/running/done/error) and result when complete.",
  parameters: Params,
  execute: async ({ taskId }, ctx) => {
    const pool = getPool();
    const { rows } = await pool.query<{
      status: string;
      result: string | null;
      error_message: string | null;
      tool_name: string;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT tt.status, tt.result, tt.error_message, tt.tool_name, tt.created_at, tt.updated_at
       FROM tool_tasks tt
       WHERE tt.id = $1
         AND tt.session_id IN (
           SELECT id FROM sessions WHERE user_id = $2
         )`,
      [taskId, ctx.uid],
    );

    if (rows.length === 0) {
      return { error: `Task ${taskId} not found` };
    }

    const row = rows[0]!;
    if (row.status === "done" && row.result) {
      try {
        return { status: "done", taskId, toolName: row.tool_name, result: JSON.parse(row.result) };
      } catch {
        return { status: "done", taskId, toolName: row.tool_name, result: row.result };
      }
    }

    return {
      status: row.status,
      taskId,
      toolName: row.tool_name,
      error: row.error_message ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  },
});
