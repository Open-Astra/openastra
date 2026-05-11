// ── Differential Privacy Noise Injection ─────────────────────────────
// Add calibrated Laplace noise to numeric analytics values.
// Provides ε-differential privacy for exported aggregate statistics.

import { createLogger } from "../utils/logger.js";

const logger = createLogger("dp-noise");

/**
 * Sample from the Laplace distribution with mean=0, scale=b.
 * Uses the inverse CDF method with crypto-random uniform samples.
 */
function laplaceSample(scale: number): number {
  // Generate uniform random in (0, 1) exclusive
  const u = (Math.random() - 0.5);
  return -scale * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));
}

export interface DpConfig {
  epsilon: number;    // Privacy budget (lower = more private). Typical: 0.1–10
  sensitivity: number; // Global sensitivity of the query (max change from one record)
}

/**
 * Add Laplace noise to a single numeric value.
 * scale = sensitivity / epsilon
 */
export function addNoise(value: number, config: DpConfig): number {
  const { epsilon, sensitivity } = config;
  if (epsilon <= 0) throw new Error("epsilon must be positive");
  if (sensitivity <= 0) throw new Error("sensitivity must be positive");

  const scale = sensitivity / epsilon;
  return value + laplaceSample(scale);
}

/**
 * Add Laplace noise to all numeric values in an object.
 * Non-numeric values are passed through unchanged.
 */
export function addNoiseToRecord<T extends Record<string, unknown>>(
  record: T,
  config: DpConfig,
  fieldsToNoise?: (keyof T)[],
): T {
  const result = { ...record };
  const fields = fieldsToNoise ?? Object.keys(record);

  for (const field of fields) {
    const val = result[field as keyof T];
    if (typeof val === "number") {
      (result as Record<string, unknown>)[field as string] = addNoise(val, config);
    }
  }

  return result;
}

/**
 * Add noise to an array of records (e.g., analytics rows).
 * Rounds noised values to integers if the original was an integer.
 */
export function addNoiseToArray<T extends Record<string, unknown>>(
  records: T[],
  config: DpConfig,
  fieldsToNoise?: (keyof T)[],
): T[] {
  return records.map((record) => {
    const noised = addNoiseToRecord(record, config, fieldsToNoise);
    // Round integer fields
    const fields = fieldsToNoise ?? Object.keys(record);
    for (const field of fields) {
      const original = record[field as keyof T];
      const noisedVal = noised[field as keyof T];
      if (typeof original === "number" && Number.isInteger(original) && typeof noisedVal === "number") {
        (noised as Record<string, unknown>)[field as string] = Math.max(0, Math.round(noisedVal));
      }
    }
    return noised;
  });
}

logger.dim("Differential privacy module loaded (Laplace mechanism)");
