import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";

// ── Timer Skill ─────────────────────────────────────────────────────
// Countdown timers, stopwatch, and pomodoro tracking.
// In-memory state scoped per user.

const StartTimerParams = z.object({
  name: z.string().describe("Timer name"),
  durationMinutes: z.number().positive().max(1440).describe("Duration in minutes"),
  type: z.enum(["countdown", "pomodoro"]).default("countdown"),
});

const CheckTimerParams = z.object({
  name: z.string().optional().describe("Timer name (default: check all)"),
});

const StopTimerParams = z.object({
  name: z.string().describe("Timer name to stop"),
});

const PomodoroParams = z.object({
  workMinutes: z.number().int().min(1).max(120).default(25),
  breakMinutes: z.number().int().min(1).max(30).default(5),
  sessions: z.number().int().min(1).max(12).default(4),
});

interface TimerState {
  name: string;
  type: string;
  startedAt: number;
  durationMs: number;
  uid: string;
}

const timers = new Map<string, TimerState>();

const timerSkill: SkillDefinition = {
  name: "timer",
  version: "1.0.0",

  manifest: {
    id: "timer",
    name: "Timer",
    description: "Countdown timers, stopwatch, and pomodoro session tracking.",
    category: "execute",
    tools: ["timer_start", "timer_check", "timer_stop", "timer_pomodoro"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    const timerKey = (uid: string, name: string) => `${uid}:${name}`;

    ctx.registerTool({
      name: "timer_start",
      description: "Start a countdown timer with a specified duration.",
      parameters: StartTimerParams,

      async execute(params, toolCtx) {
        const key = timerKey(toolCtx.uid, params.name);
        if (timers.has(key)) return { error: `Timer "${params.name}" already running.` };

        const state: TimerState = {
          name: params.name,
          type: params.type,
          startedAt: Date.now(),
          durationMs: params.durationMinutes * 60_000,
          uid: toolCtx.uid,
        };

        timers.set(key, state);

        return {
          success: true,
          name: params.name,
          duration: `${params.durationMinutes} minutes`,
          endsAt: new Date(state.startedAt + state.durationMs).toISOString(),
        };
      },
    });

    ctx.registerTool({
      name: "timer_check",
      description: "Check the status of active timers.",
      parameters: CheckTimerParams,

      async execute(params, toolCtx) {
        const now = Date.now();

        if (params.name) {
          const key = timerKey(toolCtx.uid, params.name);
          const timer = timers.get(key);
          if (!timer) return { error: `No timer named "${params.name}" found.` };

          const elapsed = now - timer.startedAt;
          const remaining = Math.max(0, timer.durationMs - elapsed);
          const finished = remaining === 0;

          if (finished) timers.delete(key);

          return {
            name: timer.name,
            type: timer.type,
            finished,
            elapsed: `${Math.round(elapsed / 60_000)} minutes`,
            remaining: `${Math.round(remaining / 60_000)} minutes`,
            remainingSeconds: Math.round(remaining / 1000),
          };
        }

        // Check all timers for this user
        const userTimers: Array<Record<string, unknown>> = [];
        for (const [key, timer] of timers) {
          if (timer.uid !== toolCtx.uid) continue;
          const elapsed = now - timer.startedAt;
          const remaining = Math.max(0, timer.durationMs - elapsed);
          const finished = remaining === 0;

          if (finished) timers.delete(key);

          userTimers.push({
            name: timer.name,
            type: timer.type,
            finished,
            remaining: `${Math.round(remaining / 60_000)}m ${Math.round((remaining % 60_000) / 1000)}s`,
          });
        }

        return { count: userTimers.length, timers: userTimers };
      },
    });

    ctx.registerTool({
      name: "timer_stop",
      description: "Stop and remove a timer.",
      parameters: StopTimerParams,

      async execute(params, toolCtx) {
        const key = timerKey(toolCtx.uid, params.name);
        const timer = timers.get(key);
        if (!timer) return { error: `No timer named "${params.name}" found.` };

        const elapsed = Date.now() - timer.startedAt;
        timers.delete(key);

        return { stopped: params.name, elapsed: `${Math.round(elapsed / 60_000)} minutes` };
      },
    });

    ctx.registerTool({
      name: "timer_pomodoro",
      description: "Start a pomodoro work session plan. Returns the schedule of work and break intervals.",
      parameters: PomodoroParams,

      async execute(params) {
        const schedule: Array<{ session: number; type: string; duration: string; startsAt: string }> = [];
        const now = Date.now();
        let offset = 0;

        for (let i = 1; i <= params.sessions; i++) {
          schedule.push({
            session: i,
            type: "work",
            duration: `${params.workMinutes}m`,
            startsAt: new Date(now + offset).toISOString().slice(11, 16),
          });
          offset += params.workMinutes * 60_000;

          if (i < params.sessions) {
            const breakDur = i % 4 === 0 ? params.breakMinutes * 3 : params.breakMinutes;
            schedule.push({
              session: i,
              type: i % 4 === 0 ? "long break" : "break",
              duration: `${breakDur}m`,
              startsAt: new Date(now + offset).toISOString().slice(11, 16),
            });
            offset += breakDur * 60_000;
          }
        }

        return {
          sessions: params.sessions,
          workMinutes: params.workMinutes,
          breakMinutes: params.breakMinutes,
          totalDuration: `${Math.round(offset / 60_000)} minutes`,
          endsAt: new Date(now + offset).toISOString(),
          schedule,
        };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "timer",
      instructions: "You can manage timers with `timer_start` (countdown), `timer_check` (status), `timer_stop` (cancel), and `timer_pomodoro` (plan a focus session).",
    };
  },
};

export default timerSkill;
