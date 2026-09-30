/**
 * Extraction helpers for the `AF_initDataCallback` payloads that Google Play
 * embeds in its server rendered HTML.
 *
 * Play ships several `<script>` blocks of the form:
 *
 *   AF_initDataCallback({key: 'ds:4', hash: '1', data:[...], sideChannel: {}});
 *
 * The `data` value is a JSON array, so we slice it out between `data:` and the
 * trailing `, sideChannel:` marker instead of trying to balance brackets by
 * hand. If that marker is missing we fall back to the end of the statement.
 */

export interface AfScript {
  key: string;
  data: unknown;
}

const CALLBACK_START = "AF_initDataCallback({";

function sliceDataPayload(source: string, dataStart: number): string | null {
  const sideChannelIdx = source.indexOf(", sideChannel:", dataStart);
  if (sideChannelIdx !== -1) {
    return source.slice(dataStart, sideChannelIdx);
  }
  const statementEnd = source.indexOf("});", dataStart);
  if (statementEnd !== -1) {
    return source.slice(dataStart, statementEnd);
  }
  return null;
}

export function extractAfScripts(html: string): AfScript[] {
  const scripts: AfScript[] = [];
  let searchFrom = 0;

  while (true) {
    const start = html.indexOf(CALLBACK_START, searchFrom);
    if (start === -1) break;

    const keyMatch = /key:\s*'([^']+)'/.exec(html.slice(start, start + 200));
    const dataIdx = html.indexOf("data:", start);
    if (dataIdx === -1 || dataIdx - start > 300) {
      searchFrom = start + CALLBACK_START.length;
      continue;
    }

    const payload = sliceDataPayload(html, dataIdx + "data:".length);
    if (payload === null) {
      searchFrom = dataIdx + 5;
      continue;
    }

    try {
      const data = JSON.parse(payload) as unknown;
      scripts.push({ key: keyMatch ? keyMatch[1] : `unknown-${scripts.length}`, data });
    } catch {
      // A single malformed payload must never abort parsing of the page.
    }

    searchFrom = dataIdx + payload.length;
  }

  return scripts;
}

export function findAfData(html: string, preferredKey = "ds:4"): unknown | null {
  const scripts = extractAfScripts(html);
  if (scripts.length === 0) return null;
  const preferred = scripts.find((script) => script.key === preferredKey);
  if (preferred) return preferred.data;
  // Fall back to the largest payload: that is the one holding the results.
  let largest: AfScript | null = null;
  for (const script of scripts) {
    if (!largest || JSON.stringify(script.data).length > JSON.stringify(largest.data).length) {
      largest = script;
    }
  }
  return largest ? largest.data : null;
}

export function findAfDataByKeyPrefix(html: string, prefix: string): unknown | null {
  const scripts = extractAfScripts(html);
  const match = scripts.find((script) => script.key.startsWith(prefix));
  return match ? match.data : null;
}
