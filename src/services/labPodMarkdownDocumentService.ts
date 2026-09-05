import {
  LABPOD_MARKDOWN_DIAGNOSTIC_CODES,
  type LabPodMarkdownBlockParseResult,
  type LabPodMarkdownBlockRanges,
  type LabPodMarkdownBlockType,
  type LabPodMarkdownDiagnostic,
  type LabPodMarkdownDocumentParseResult,
  type LabPodMarkdownNewlineStyle,
  type LabPodMarkdownRange,
  type SerializeLabPodMarkdownDocumentInput,
  type UpsertLabPodStandardBlocksInput,
  type UpsertLabPodStandardBlocksOptions,
  type UpsertLabPodStandardBlocksResult
} from "../types/labPodMarkdownBlocks";

export const LABPOD_MARKDOWN_MARKERS = Object.freeze({
  metaSnapshot: Object.freeze({
    start: "<!-- LABPOD_META_SNAPSHOT_START -->",
    end: "<!-- LABPOD_META_SNAPSHOT_END -->"
  }),
  outline: Object.freeze({
    start: "<!-- LABPOD_OUTLINE_START -->",
    end: "<!-- LABPOD_OUTLINE_END -->"
  }),
  body: Object.freeze({
    start: "<!-- LABPOD_BODY_START -->",
    end: "<!-- LABPOD_BODY_END -->"
  })
} as const);

const BLOCK_ORDER: LabPodMarkdownBlockType[] = ["metaSnapshot", "outline", "body"];
const BOM = "\uFEFF";

type LogicalLine = {
  start: number;
  end: number;
  fullEnd: number;
  text: string;
  newline: "\n" | "\r\n" | "";
};

type MarkerEvent = {
  blockType: LabPodMarkdownBlockType;
  kind: "start" | "end";
  range: LabPodMarkdownRange;
  line: LogicalLine;
};

function logicalLines(markdown: string): LogicalLine[] {
  const lines: LogicalLine[] = [];
  let start = 0;
  for (let index = 0; index < markdown.length; index += 1) {
    if (markdown[index] !== "\n") continue;
    const crlf = index > start && markdown[index - 1] === "\r";
    const end = crlf ? index - 1 : index;
    lines.push({
      start,
      end,
      fullEnd: index + 1,
      text: markdown.slice(start, end),
      newline: crlf ? "\r\n" : "\n"
    });
    start = index + 1;
  }
  lines.push({
    start,
    end: markdown.length,
    fullEnd: markdown.length,
    text: markdown.slice(start),
    newline: ""
  });
  return lines;
}

function newlineContract(markdown: string): {
  style: LabPodMarkdownNewlineStyle;
  preferred: "\n" | "\r\n";
} {
  const crlfCount = (markdown.match(/\r\n/gu) ?? []).length;
  const lfCount = (markdown.match(/(?<!\r)\n/gu) ?? []).length;
  if (crlfCount && lfCount) return { style: "mixed", preferred: "\n" };
  if (crlfCount) return { style: "crlf", preferred: "\r\n" };
  if (lfCount) return { style: "lf", preferred: "\n" };
  return { style: "none", preferred: "\n" };
}

function exactMarker(line: LogicalLine): MarkerEvent | undefined {
  for (const blockType of BLOCK_ORDER) {
    for (const kind of ["start", "end"] as const) {
      const token = LABPOD_MARKDOWN_MARKERS[blockType][kind];
      const match = line.text.match(new RegExp(`^([ \\t]*)${escapeRegExp(token)}[ \\t]*$`, "u"));
      if (match) {
        const start = line.start + match[1].length;
        return { blockType, kind, range: { start, end: start + token.length }, line };
      }
    }
  }
  return undefined;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function malformedMarkerRange(line: LogicalLine): LabPodMarkdownRange | undefined {
  const trimmed = line.text.trim();
  if (!trimmed.startsWith("<!--") || !trimmed.includes("LABPOD_")) return undefined;
  if (!/(?:META_SNAPSHOT|OUTLINE|BODY)_(?:START|END)/u.test(trimmed)) return undefined;
  return { start: line.start, end: line.end };
}

function fenceOpening(line: string) {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
  if (!match) return undefined;
  if (match[1][0] === "`" && match[2].includes("`")) return undefined;
  return { character: match[1][0], length: match[1].length };
}

function isFenceClosing(line: string, fence: { character: string; length: number }) {
  const escaped = escapeRegExp(fence.character);
  return new RegExp(`^ {0,3}${escaped}{${fence.length},}[ \\t]*$`, "u").test(line);
}

function contentEnd(markdown: string, contentStart: number, endMarkerLineStart: number) {
  if (endMarkerLineStart <= contentStart) return contentStart;
  if (markdown.slice(endMarkerLineStart - 2, endMarkerLineStart) === "\r\n") {
    return endMarkerLineStart - 2;
  }
  if (markdown[endMarkerLineStart - 1] === "\n") return endMarkerLineStart - 1;
  return endMarkerLineStart;
}

function blockMissingCode(blockType: LabPodMarkdownBlockType) {
  if (blockType === "metaSnapshot") return LABPOD_MARKDOWN_DIAGNOSTIC_CODES.metaMissing;
  if (blockType === "outline") return LABPOD_MARKDOWN_DIAGNOSTIC_CODES.outlineMissing;
  return LABPOD_MARKDOWN_DIAGNOSTIC_CODES.bodyMissing;
}

function diagnostic(
  code: LabPodMarkdownDiagnostic["code"],
  message: string,
  options: Partial<Omit<LabPodMarkdownDiagnostic, "code" | "message">> = {}
): LabPodMarkdownDiagnostic {
  return { code, message, severity: "error", ...options };
}

function outsideSegments(markdown: string, ranges: LabPodMarkdownRange[]) {
  const sorted = [...ranges].sort((left, right) => left.start - right.start);
  const outsideRanges: LabPodMarkdownRange[] = [];
  let cursor = 0;
  for (const range of sorted) {
    if (range.start > cursor) outsideRanges.push({ start: cursor, end: range.start });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < markdown.length) outsideRanges.push({ start: cursor, end: markdown.length });
  return {
    outsideRanges,
    outsideContent: outsideRanges.map((range) => markdown.slice(range.start, range.end)).join("")
  };
}

export function parseLabPodMarkdownDocument(markdownInput: string): LabPodMarkdownDocumentParseResult {
  const original = String(markdownInput ?? "");
  const hasBom = original.startsWith(BOM);
  const offset = hasBom ? 1 : 0;
  const markdown = hasBom ? original.slice(1) : original;
  const newline = newlineContract(markdown);
  const diagnostics: LabPodMarkdownDiagnostic[] = [];
  if (newline.style === "mixed") {
    diagnostics.push(diagnostic(
      LABPOD_MARKDOWN_DIAGNOSTIC_CODES.mixedNewlines,
      "Document contains mixed LF and CRLF newlines.",
      { severity: "warning" }
    ));
  }
  const events: MarkerEvent[] = [];
  let fence: { character: string; length: number; range: LabPodMarkdownRange } | undefined;
  for (const line of logicalLines(markdown)) {
    if (fence) {
      if (isFenceClosing(line.text, fence)) fence = undefined;
      continue;
    }
    const opening = fenceOpening(line.text);
    if (opening) {
      fence = { ...opening, range: { start: line.start + offset, end: line.end + offset } };
      continue;
    }
    const marker = exactMarker(line);
    if (marker) {
      events.push({
        ...marker,
        range: { start: marker.range.start + offset, end: marker.range.end + offset },
        line: {
          ...marker.line,
          start: marker.line.start + offset,
          end: marker.line.end + offset,
          fullEnd: marker.line.fullEnd + offset
        }
      });
      continue;
    }
    const malformed = malformedMarkerRange(line);
    if (malformed) {
      diagnostics.push(diagnostic(
        LABPOD_MARKDOWN_DIAGNOSTIC_CODES.markerMalformed,
        "A LABPOD-like marker line is malformed and is not recognized.",
        { range: { start: malformed.start + offset, end: malformed.end + offset } }
      ));
    }
  }
  if (fence) {
    diagnostics.push(diagnostic(
      LABPOD_MARKDOWN_DIAGNOSTIC_CODES.unclosedFence,
      "A fenced code block is not closed; marker-like lines after it are ignored.",
      { severity: "warning", range: fence.range }
    ));
  }

  const blocks = {} as Record<LabPodMarkdownBlockType, LabPodMarkdownBlockParseResult>;
  const fullRanges: LabPodMarkdownRange[] = [];
  for (const blockType of BLOCK_ORDER) {
    const starts = events.filter((event) => event.blockType === blockType && event.kind === "start");
    const ends = events.filter((event) => event.blockType === blockType && event.kind === "end");
    let block: LabPodMarkdownBlockParseResult = {
      type: blockType,
      status: "missing",
      startMarkerCount: starts.length,
      endMarkerCount: ends.length
    };
    if (starts.length === 0 && ends.length === 0) {
      diagnostics.push(diagnostic(blockMissingCode(blockType), `${blockType} block is missing.`, { blockType }));
    } else if (starts.length > 1 || ends.length > 1) {
      block = { ...block, status: "ambiguous" };
      diagnostics.push(diagnostic(
        LABPOD_MARKDOWN_DIAGNOSTIC_CODES.duplicate,
        `${blockType} contains duplicate start or end markers.`,
        { blockType, details: { startCount: starts.length, endCount: ends.length } }
      ));
      diagnostics.push(diagnostic(
        LABPOD_MARKDOWN_DIAGNOSTIC_CODES.ambiguous,
        `${blockType} cannot be resolved uniquely.`,
        { blockType }
      ));
    } else if (starts.length === 0 || ends.length === 0) {
      block = { ...block, status: "invalid" };
      diagnostics.push(diagnostic(
        starts.length === 0
          ? LABPOD_MARKDOWN_DIAGNOSTIC_CODES.startMissing
          : LABPOD_MARKDOWN_DIAGNOSTIC_CODES.endMissing,
        `${blockType} has an incomplete marker pair.`,
        { blockType, range: (starts[0] ?? ends[0])?.range }
      ));
    } else if (starts[0].range.start >= ends[0].range.start) {
      block = { ...block, status: "invalid" };
      diagnostics.push(diagnostic(
        LABPOD_MARKDOWN_DIAGNOSTIC_CODES.orderInvalid,
        `${blockType} end marker occurs before its start marker.`,
        { blockType, range: ends[0].range }
      ));
    } else {
      const start = starts[0];
      const end = ends[0];
      const startContent = start.line.fullEnd;
      const endContent = contentEnd(original, startContent, end.line.start);
      const content = original.slice(startContent, endContent);
      const ranges: LabPodMarkdownBlockRanges = {
        startMarkerRange: start.range,
        contentRange: { start: startContent, end: endContent },
        endMarkerRange: end.range,
        fullRange: { start: start.line.start, end: end.line.fullEnd }
      };
      block = {
        ...block,
        status: content.trim().length === 0 ? "valid-empty" : "valid",
        content,
        ranges
      };
      fullRanges.push(ranges.fullRange);
    }
    blocks[blockType] = block;
  }

  const uniqueEvents = events.filter((event) => {
    const block = blocks[event.blockType];
    return block.startMarkerCount === 1 && block.endMarkerCount === 1;
  }).sort((left, right) => left.range.start - right.range.start);
  const stack: MarkerEvent[] = [];
  let structureInvalid = false;
  for (const event of uniqueEvents) {
    if (event.kind === "start") {
      if (stack.length > 0) {
        structureInvalid = true;
        diagnostics.push(diagnostic(
          LABPOD_MARKDOWN_DIAGNOSTIC_CODES.nested,
          `${event.blockType} starts inside ${stack[stack.length - 1].blockType}.`,
          { blockType: event.blockType, range: event.range }
        ));
      }
      stack.push(event);
    } else {
      const current = stack.pop();
      if (!current || current.blockType !== event.blockType) {
        structureInvalid = true;
        diagnostics.push(diagnostic(
          LABPOD_MARKDOWN_DIAGNOSTIC_CODES.overlapped,
          `${event.blockType} closes a different or unopened block.`,
          { blockType: event.blockType, range: event.range }
        ));
      }
    }
  }
  const completeStarts = BLOCK_ORDER
    .map((blockType) => ({ blockType, start: blocks[blockType].ranges?.fullRange.start }))
    .filter((item): item is { blockType: LabPodMarkdownBlockType; start: number } => item.start !== undefined)
    .sort((left, right) => left.start - right.start);
  for (let index = 1; index < completeStarts.length; index += 1) {
    if (BLOCK_ORDER.indexOf(completeStarts[index - 1].blockType) > BLOCK_ORDER.indexOf(completeStarts[index].blockType)) {
      structureInvalid = true;
      diagnostics.push(diagnostic(
        LABPOD_MARKDOWN_DIAGNOSTIC_CODES.orderInvalid,
        "Standard blocks are not in META_SNAPSHOT -> OUTLINE -> BODY order.",
        { range: { start: completeStarts[index].start, end: completeStarts[index].start } }
      ));
      break;
    }
  }

  const outside = outsideSegments(original, fullRanges);
  const outsideWithoutBom = hasBom && outside.outsideContent.startsWith(BOM)
    ? outside.outsideContent.slice(1)
    : outside.outsideContent;
  if (outsideWithoutBom.trim().length > 0) {
    diagnostics.push(diagnostic(
      LABPOD_MARKDOWN_DIAGNOSTIC_CODES.outsideContent,
      "Document contains non-whitespace content outside standard blocks.",
      { severity: "warning" }
    ));
  }

  const blockStatuses = BLOCK_ORDER.map((blockType) => blocks[blockType].status);
  const status = blockStatuses.includes("ambiguous")
    ? "ambiguous"
    : structureInvalid || diagnostics.some((item) =>
        item.severity === "error" && item.code === LABPOD_MARKDOWN_DIAGNOSTIC_CODES.markerMalformed
      ) || blockStatuses.includes("invalid")
      ? "invalid"
      : blockStatuses.includes("missing")
        ? "missing"
        : blockStatuses.every((item) => item === "valid-empty")
          ? "valid-empty"
          : "valid";
  if (structureInvalid) {
    for (const blockType of BLOCK_ORDER) {
      if (blocks[blockType].status === "valid" || blocks[blockType].status === "valid-empty") {
        blocks[blockType] = { ...blocks[blockType], status: "invalid" };
      }
    }
  }

  return {
    status,
    metaSnapshot: blocks.metaSnapshot.content,
    outline: blocks.outline.content,
    body: blocks.body.content,
    blocks,
    newlineStyle: newline.style,
    preferredNewline: newline.preferred,
    hasBom,
    diagnostics,
    ranges: Object.fromEntries(
      BLOCK_ORDER.flatMap((blockType) => blocks[blockType].ranges ? [[blockType, blocks[blockType].ranges]] : [])
    ),
    outsideContent: outside.outsideContent,
    outsideRanges: outside.outsideRanges
  };
}

function normalizeNewlines(value: string, newline: "\n" | "\r\n") {
  return value.replace(/\r\n|\n/gu, "\n").replace(/\n/gu, newline);
}

function blockText(
  blockType: LabPodMarkdownBlockType,
  content: string,
  newline: "\n" | "\r\n"
) {
  const normalized = normalizeNewlines(String(content ?? ""), newline);
  return `${LABPOD_MARKDOWN_MARKERS[blockType].start}${newline}${normalized}${
    normalized.length > 0 ? newline : ""
  }${LABPOD_MARKDOWN_MARKERS[blockType].end}`;
}

export function serializeLabPodMarkdownDocument(input: SerializeLabPodMarkdownDocumentInput) {
  const newline = input.newlineStyle === "crlf" ? "\r\n" : "\n";
  let markdown = BLOCK_ORDER.map((blockType) => blockText(
    blockType,
    blockType === "metaSnapshot" ? input.metaSnapshot : blockType === "outline" ? input.outline : input.body,
    newline
  )).join(`${newline}${newline}`);
  if (input.trailingNewline !== false) markdown += newline;
  if (input.preserveBom === true) markdown = `${BOM}${markdown}`;
  return markdown;
}

function serializerError(
  source: LabPodMarkdownDocumentParseResult,
  code: LabPodMarkdownDiagnostic["code"],
  message: string
): UpsertLabPodStandardBlocksResult {
  return { status: "error", source, diagnostics: [diagnostic(code, message)] };
}

function applyTrailingNewline(markdown: string, newline: "\n" | "\r\n", trailing?: boolean) {
  const withoutTrailing = markdown.replace(/(?:\r\n|\n)+$/u, "");
  if (trailing === true) return `${withoutTrailing}${newline}`;
  if (trailing === false) return withoutTrailing;
  return markdown;
}

export function upsertLabPodStandardBlocks(
  existingMarkdown: string,
  blocks: UpsertLabPodStandardBlocksInput,
  options: UpsertLabPodStandardBlocksOptions = {}
): UpsertLabPodStandardBlocksResult {
  const source = parseLabPodMarkdownDocument(existingMarkdown);
  const mode = options.mode ?? "strict";
  if (mode !== "strict" && mode !== "normalize") {
    return serializerError(
      source,
      LABPOD_MARKDOWN_DIAGNOSTIC_CODES.serializeUnsupportedMode,
      `Unsupported serializer mode: ${String(mode)}.`
    );
  }
  if (source.status === "ambiguous") {
    return serializerError(
      source,
      LABPOD_MARKDOWN_DIAGNOSTIC_CODES.serializeAmbiguousSource,
      "Ambiguous standard blocks cannot be rewritten automatically."
    );
  }
  if (source.status === "invalid") {
    return serializerError(
      source,
      LABPOD_MARKDOWN_DIAGNOSTIC_CODES.serializeInvalidSource,
      "Invalid standard blocks cannot be rewritten automatically."
    );
  }
  if (source.status === "missing" && mode === "strict") {
    return serializerError(
      source,
      LABPOD_MARKDOWN_DIAGNOSTIC_CODES.serializeMissingSource,
      "Strict mode refuses documents with missing standard blocks."
    );
  }

  const newline = options.newlineStyle === "crlf"
    ? "\r\n"
    : options.newlineStyle === "lf"
      ? "\n"
      : source.newlineStyle === "crlf"
        ? "\r\n"
        : "\n";
  const preserveBom = options.preserveBom ?? source.hasBom;
  if (source.status === "missing") {
    const serialized = serializeLabPodMarkdownDocument({
      metaSnapshot: blocks.metaSnapshot ?? source.metaSnapshot ?? "",
      outline: blocks.outline ?? source.outline ?? "",
      body: blocks.body ?? source.body ?? "",
      newlineStyle: newline === "\r\n" ? "crlf" : "lf",
      preserveBom,
      trailingNewline: options.trailingNewline ?? true
    });
    const outside = options.preserveOutsideContent === false
      ? ""
      : normalizeNewlines(source.outsideContent.replace(/^\uFEFF/u, ""), newline);
    const meaningfulOutside = outside.trim().length > 0 ? outside : "";
    const markdown = meaningfulOutside
      ? `${serialized.replace(/(?:\r\n|\n)+$/u, "")}${newline}${newline}${meaningfulOutside}`
      : serialized;
    return {
      status: "success",
      source,
      markdown: applyTrailingNewline(markdown, newline, options.trailingNewline),
      diagnostics: source.diagnostics
    };
  }

  const replacements = BLOCK_ORDER.flatMap((blockType) => {
    const value = blocks[blockType];
    const range = source.blocks[blockType].ranges?.contentRange;
    const endMarkerStart = source.blocks[blockType].ranges?.endMarkerRange.start;
    if (value === undefined || !range || endMarkerStart === undefined) return [];
    let normalizedValue = normalizeNewlines(value, newline);
    const boundary = existingMarkdown.slice(range.end, endMarkerStart);
    if (normalizedValue.length > 0 && !boundary.includes("\n")) normalizedValue += newline;
    return [{ range, value: normalizedValue }];
  }).sort((left, right) => right.range.start - left.range.start);
  let markdown = existingMarkdown;
  for (const replacement of replacements) {
    markdown = `${markdown.slice(0, replacement.range.start)}${replacement.value}${markdown.slice(replacement.range.end)}`;
  }
  markdown = normalizeNewlines(markdown, newline);
  markdown = preserveBom
    ? `${BOM}${markdown.replace(/^\uFEFF/u, "")}`
    : markdown.replace(/^\uFEFF/u, "");
  markdown = applyTrailingNewline(markdown, newline, options.trailingNewline);
  return { status: "success", source, markdown, diagnostics: source.diagnostics };
}

export const labPodMarkdownDocumentService = {
  parse: parseLabPodMarkdownDocument,
  serialize: serializeLabPodMarkdownDocument,
  upsert: upsertLabPodStandardBlocks,
  markers: LABPOD_MARKDOWN_MARKERS
};
