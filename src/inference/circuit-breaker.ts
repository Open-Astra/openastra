import { createLogger } from "../utils/logger.js";
import { getPool } from "../config/postgres.js";

// ── Circuit Breaker ──────────────────────────────────────────────────
// Prevents cascading failures by fast-failing when a provider is down.
// Three states:
//   CLOSED   — normal operation, tracking failures in rolling window
//   OPEN     — provider is down, fail fast without calling it
//   HALF-OPEN — testing if provider recovered, allowing limited traffic

const log = createLogger("circuit-breaker");

type State = "closed" | "open" | "half-open";

interface CircuitBreakerOptions {
  failureThreshold?: number; // failures in window before opening (default 5)
  successThreshold?: number; // consecutive successes to close from half-open (default 2)
  timeoutMs?: number;        // ms to stay open before testing (default 60_000)
  windowMs?: number;         // rolling window for failure counting (default 60_000)
}

export interface CircuitBreakerState {
  state: State;
  totalRequests: number;
  totalSuccesses: number;
  lastFailureAt: number | null;
  p50Ms?: number;
  p95Ms?: number;
  p99Ms?: number;
}

class CircuitBreaker {
  private state: State = "closed";
  private failureTimes: number[] = [];
  private consecutiveSuccesses = 0;
  private openedAt: number | null = null;
  private _totalRequests = 0;
  private _totalSuccesses = 0;
  private _lastFailureAt: number | null = null;
  private latencies: number[] = []; // Circular buffer (max 100 entries)
  private readonly MAX_LATENCIES = 100;

  private readonly label: string;
  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly timeoutMs: number;
  private readonly windowMs: number;

  constructor(label: string, options: CircuitBreakerOptions = {}) {
    this.label = label;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.successThreshold = options.successThreshold ?? 2;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.windowMs = options.windowMs ?? 60_000;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const now = Date.now();
    this._totalRequests++;

    if (this.state === "open") {
      if (this.openedAt !== null && now - this.openedAt >= this.timeoutMs) {
        // Timeout elapsed — try half-open
        const _prevState: State = "open";
        this.state = "half-open";
        this.consecutiveSuccesses = 0;
        log.dim(`[${this.label}] → HALF-OPEN (testing recovery)`);
        const _errRate = this._totalRequests > 0
          ? (this._totalRequests - this._totalSuccesses) / this._totalRequests
          : 0;
        getPool().query(
          `INSERT INTO circuit_breaker_history (provider, from_state, to_state, reason, total_requests, error_rate)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [this.label, _prevState, "half-open", "timeout elapsed", this._totalRequests, _errRate],
        ).catch(() => {});
      } else {
        throw new Error(`[circuit-breaker] ${this.label} is OPEN — fast failing`);
      }
    }

    const start = Date.now();
    try {
      const result = await fn();
      const duration = Date.now() - start;
      this.recordLatency(duration);
      this._totalSuccesses++;
      this.onSuccess();
      return result;
    } catch (err) {
      const duration = Date.now() - start;
      this.recordLatency(duration);
      this._lastFailureAt = now;
      this.onFailure(now);
      throw err;
    }
  }

  getState(): CircuitBreakerState {
    return {
      state: this.state,
      totalRequests: this._totalRequests,
      totalSuccesses: this._totalSuccesses,
      lastFailureAt: this._lastFailureAt,
      p50Ms: this.getLatencyPercentile(50),
      p95Ms: this.getLatencyPercentile(95),
      p99Ms: this.getLatencyPercentile(99),
    };
  }

  private recordLatency(duration: number): void {
    this.latencies.push(duration);
    if (this.latencies.length > this.MAX_LATENCIES) {
      this.latencies.shift();
    }
  }

  private getLatencyPercentile(percentile: number): number {
    if (this.latencies.length === 0) return 0;
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const index = Math.floor((sorted.length * percentile) / 100);
    return sorted[index] ?? 0;
  }

  private onSuccess(): void {
    if (this.state === "half-open") {
      this.consecutiveSuccesses++;
      if (this.consecutiveSuccesses >= this.successThreshold) {
        this.state = "closed";
        this.failureTimes = [];
        this.openedAt = null;
        this.consecutiveSuccesses = 0;
        log.active(`[${this.label}] → CLOSED (recovered)`);
        const _errRate = this._totalRequests > 0
          ? (this._totalRequests - this._totalSuccesses) / this._totalRequests
          : 0;
        getPool().query(
          `INSERT INTO circuit_breaker_history (provider, from_state, to_state, reason, total_requests, error_rate)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [this.label, "half-open", "closed", "recovery confirmed", this._totalRequests, _errRate],
        ).catch(() => {});
      }
    } else if (this.state === "closed") {
      // Reset consecutive successes counter (not strictly needed but clear)
      this.consecutiveSuccesses = 0;
    }
  }

  private onFailure(now: number): void {
    if (this.state === "half-open") {
      // Any failure in half-open reopens immediately
      this.state = "open";
      this.openedAt = now;
      this.consecutiveSuccesses = 0;
      log.warn(`[${this.label}] → OPEN (half-open test failed)`);
      const _errRate1 = this._totalRequests > 0
        ? (this._totalRequests - this._totalSuccesses) / this._totalRequests
        : 0;
      getPool().query(
        `INSERT INTO circuit_breaker_history (provider, from_state, to_state, reason, total_requests, error_rate)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [this.label, "half-open", "open", "half-open test failed", this._totalRequests, _errRate1],
      ).catch(() => {});
      return;
    }

    // CLOSED: track failure in rolling window
    this.failureTimes.push(now);
    // Drop failures outside the window
    this.failureTimes = this.failureTimes.filter((t) => now - t <= this.windowMs);

    if (this.failureTimes.length >= this.failureThreshold) {
      this.state = "open";
      this.openedAt = now;
      log.warn(`[${this.label}] → OPEN (${this.failureTimes.length} failures in ${this.windowMs}ms window)`);
      const _errRate2 = this._totalRequests > 0
        ? (this._totalRequests - this._totalSuccesses) / this._totalRequests
        : 0;
      getPool().query(
        `INSERT INTO circuit_breaker_history (provider, from_state, to_state, reason, total_requests, error_rate)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [this.label, "closed", "open", `${this.failureTimes.length} failures in window`, this._totalRequests, _errRate2],
      ).catch(() => {});
    }
  }

  get isOpen(): boolean {
    return this.state === "open";
  }

  get status(): State {
    return this.state;
  }
}

// ── Per-Provider Registry ────────────────────────────────────────────

const registry = new Map<string, CircuitBreaker>();

export function getCircuitBreaker(provider: string): CircuitBreaker {
  let cb = registry.get(provider);
  if (!cb) {
    cb = new CircuitBreaker(provider);
    registry.set(provider, cb);
  }
  return cb;
}

export function getCircuitBreakerStatus(): Record<string, State> {
  const result: Record<string, State> = {};
  for (const [key, cb] of registry) {
    result[key] = cb.status;
  }
  return result;
}

export function getAllCircuitBreakerStates(): Record<string, CircuitBreakerState> {
  const result: Record<string, CircuitBreakerState> = {};
  for (const [key, cb] of registry) {
    result[key] = cb.getState();
  }
  return result;
}

export { CircuitBreaker };
export type { State };
