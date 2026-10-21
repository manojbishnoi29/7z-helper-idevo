export interface ParsedCandidate {
  lineNumber: number;
  password: string;
}

export interface ParseResult {
  totalLines: number;
  validCount: number;
  candidates: ParsedCandidate[];
  hadBom: boolean;
}

/**
 * Parses raw TXT file content into ordered password candidates.
 * - Handles UTF-8 BOM (EF BB BF / \uFEFF) if present.
 * - Handles CRLF (\r\n) and LF (\n) line endings.
 * - Preserves spaces inside passwords exactly (no trim).
 * - Empty lines are skipped (not counted as valid) but counted in totalLines.
 * - Original line order is preserved (line numbers are 1-based).
 */
export function parseTxtContent(raw: string): ParseResult {
  let hadBom = false;
  let content = raw;

  // Strip UTF-8 BOM if present (U+FEFF at start)
  if (content.charCodeAt(0) === 0xfeff) {
    hadBom = true;
    content = content.slice(1);
  }

  // Split on both CRLF and LF; keep empty strings to count total lines
  // Normalize CRLF to LF first, then split
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');

  // If file ends with newline, split produces a trailing empty string - count it
  // But if file is empty, we get [''] => totalLines 1 with 0 valid - adjust for truly empty file
  const isEmptyFile = raw.length === 0 || (hadBom && content.length === 0);
  const totalLines = isEmptyFile ? 0 : lines.length;

  const candidates: ParsedCandidate[] = [];

  lines.forEach((line, idx) => {
    // Remove trailing \r if any remained (defensive)
    // Do NOT trim spaces - preserve exactly
    // Skip truly empty lines (zero length) — but a line with spaces IS a valid password
    if (line.length === 0) return;
    candidates.push({
      lineNumber: idx + 1,
      password: line,
    });
  });

  return {
    totalLines,
    validCount: candidates.length,
    candidates,
    hadBom,
  };
}

/**
 * Parses manual textarea input (same rules as TXT).
 */
export function parseManualInput(input: string): ParseResult {
  return parseTxtContent(input);
}

/**
 * Reads file content as UTF-8 text with BOM handling.
 * For Expo FileSystem usage, content is already a string.
 */
export function decodeUtf8WithBom(bytes: string): string {
  if (bytes.charCodeAt(0) === 0xfeff) return bytes.slice(1);
  return bytes;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
