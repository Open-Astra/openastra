// ── Agent Performance Profiler ────────────────────────────────────────
// Records timing for named phases of the agent loop execution.
// Phase marks are taken at the START of each phase; durations are
// computed as the delta between consecutive marks.

export interface ProfileReport {
  phases: Record<string, number>; // phase name → duration ms
  totalMs: number;
  bottleneck: string;             // phase with the longest duration
}

export class AgentProfiler {
  private marks: Array<{ phase: string; ts: number }> = [];
  private startTs: number;

  constructor() {
    this.startTs = Date.now();
    this.marks.push({ phase: "__start__", ts: this.startTs });
  }

  /** Record the start timestamp for a named phase. */
  mark(phase: string): void {
    this.marks.push({ phase, ts: Date.now() });
  }

  /** Finalise and compute a ProfileReport. Call once at the end of the turn. */
  end(): ProfileReport {
    const endTs = Date.now();
    const totalMs = endTs - this.startTs;
    const phases: Record<string, number> = {};

    for (let i = 1; i < this.marks.length; i++) {
      const prev = this.marks[i - 1]!;
      const curr = this.marks[i]!;
      const phaseName = curr.phase === "__start__" ? "pre" : curr.phase;
      phases[phaseName] = (phases[phaseName] ?? 0) + (curr.ts - prev.ts);
    }

    // Time from last mark to end()
    if (this.marks.length > 0) {
      const lastMark = this.marks[this.marks.length - 1]!;
      const tail = endTs - lastMark.ts;
      if (tail > 0) {
        phases["__tail__"] = tail;
      }
    }

    // Find bottleneck phase (longest duration)
    let bottleneck = "none";
    let maxDuration = -1;
    for (const [phase, duration] of Object.entries(phases)) {
      if (phase !== "__tail__" && duration > maxDuration) {
        maxDuration = duration;
        bottleneck = phase;
      }
    }

    // Remove internal bookkeeping key from report
    const { __tail__: _tail, ...reportPhases } = phases;
    void _tail;

    return { phases: reportPhases, totalMs, bottleneck };
  }
}
