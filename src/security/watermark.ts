// Unicode zero-width character steganography for workspace watermarking
// Uses zero-width space (U+200B), zero-width non-joiner (U+200C), zero-width joiner (U+200D)

const ZWS = "\u200B"; // 0
const ZWNJ = "\u200C"; // 1
const SEPARATOR = "\u200D"; // separator

function encodeWorkspaceId(workspaceId: string): string {
  // Encode first 16 chars of workspaceId as binary using ZWS/ZWNJ
  const limited = workspaceId.slice(0, 16);
  const bits: string[] = [];
  for (const char of limited) {
    const code = char.charCodeAt(0);
    for (let i = 7; i >= 0; i--) {
      bits.push((code >> i) & 1 ? ZWNJ : ZWS);
    }
    bits.push(SEPARATOR);
  }
  return bits.join("");
}

function decodeWatermark(watermark: string): string {
  const chars: string[] = [];
  const segments = watermark.split(SEPARATOR).filter(Boolean);
  for (const segment of segments) {
    let code = 0;
    for (const bit of segment) {
      code = (code << 1) | (bit === ZWNJ ? 1 : 0);
    }
    if (code > 0 && code < 128) {
      chars.push(String.fromCharCode(code));
    }
  }
  return chars.join("");
}

export function embedWatermark(text: string, workspaceId: string): string {
  const mark = encodeWorkspaceId(workspaceId);
  // Insert watermark after the first sentence or at position 100
  const insertPos = Math.min(100, text.length);
  return text.slice(0, insertPos) + mark + text.slice(insertPos);
}

export function detectWatermark(text: string): string | null {
  // Extract zero-width characters
  const zwChars = text.replace(/[^\u200B\u200C\u200D]/g, "");
  if (zwChars.length < 16) return null;
  try {
    const decoded = decodeWatermark(zwChars);
    if (decoded.length >= 4) return decoded;
    return null;
  } catch {
    return null;
  }
}
