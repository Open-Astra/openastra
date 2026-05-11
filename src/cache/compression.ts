import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { createLogger } from "../utils/logger.js";

const log = createLogger("compression");

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

const THRESHOLD_BYTES = parseInt(process.env.CACHE_COMPRESSION_THRESHOLD_BYTES ?? "1024", 10);

interface CompressionResult {
  data: string;
  compressed: boolean;
}

/**
 * Compress content if it exceeds the configured threshold.
 * Returns base64-encoded compressed data and a flag indicating whether compression was applied.
 * @param content - The content to compress
 * @returns { data: string (base64), compressed: boolean }
 */
export async function compressContent(content: string): Promise<CompressionResult> {
  try {
    const contentSize = Buffer.byteLength(content, "utf-8");

    // Only compress if above threshold
    if (contentSize <= THRESHOLD_BYTES) {
      return { data: content, compressed: false };
    }

    const compressed = await gzipAsync(content);
    const base64 = compressed.toString("base64");
    const compressedSize = Buffer.byteLength(base64, "utf-8");

    // Only use compression if it actually saves space
    if (compressedSize >= contentSize) {
      return { data: content, compressed: false };
    }

    log.dim(
      `Compressed content: ${contentSize} bytes → ${compressedSize} bytes (${((1 - compressedSize / contentSize) * 100).toFixed(1)}% saving)`,
    );

    return { data: base64, compressed: true };
  } catch (err) {
    log.warn(`Compression failed (returning uncompressed): ${err instanceof Error ? err.message : String(err)}`);
    return { data: content, compressed: false };
  }
}

/**
 * Decompress content if it was previously compressed.
 * @param data - The data to decompress (base64 if compressed, plain text if not)
 * @param compressed - Flag indicating whether the data is compressed
 * @returns The decompressed content
 */
export async function decompressContent(data: string, compressed: boolean): Promise<string> {
  if (!compressed) {
    return data;
  }

  try {
    const buffer = Buffer.from(data, "base64");
    const decompressed = await gunzipAsync(buffer);
    return decompressed.toString("utf-8");
  } catch (err) {
    log.warn(`Decompression failed: ${err instanceof Error ? err.message : String(err)}`);
    // Return the data as-is if decompression fails
    return data;
  }
}
