import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";

const calls = { reads: [], saves: [] };
const rows = new Map();
let desktop = true;
let saveResponse = { saved: true, filePath: "N:\\B7\\citation.csl.json", message: "saved" };
const bundled = await build({
  entryPoints: [path.resolve("src/services/literatureCitationExportService.ts")],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  target: "es2022",
  plugins: [{
    name: "canonical-read-and-save-ports",
    setup(plugin) {
      plugin.onResolve({ filter: /^(\.\/literatureService|\.\/exportService)$/ }, (args) => ({
        path: args.path,
        namespace: "test-port"
      }));
      plugin.onLoad({ filter: /.*/, namespace: "test-port" }, (args) => ({
        contents: args.path.endsWith("literatureService")
          ? "export const literatureService={getLiteratureById:(id)=>globalThis.__b7read(id)};"
          : "export const exportService={isDesktopRuntime:()=>globalThis.__b7desktop()};export const sanitizeFileName=(v)=>v;export const saveTextFile=(...args)=>globalThis.__b7save(...args);",
        loader: "js"
      }));
    }
  }]
});
globalThis.__b7read = async (id) => { calls.reads.push(id); return rows.get(id); };
globalThis.__b7desktop = () => desktop;
globalThis.__b7save = async (...args) => { calls.saves.push(args); return saveResponse; };
const { literatureCitationExportService: service, CitationExportPreflightError } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
);

const source = (id, title, overrides = {}) => ({
  id, title, publicationType: "journal_article", authors: [{ name: "Ada Example", orcid: "0000-0000" }],
  year: 2024, venue: "Journal Ω", doi: "10.1234/shared", url: "https://example.org/a",
  abstract: "C:\\研究\\notes.md is literal user text", keywords: ["method", "复现"],
  citationKey: "ada2024", externalIds: [{ source: "manual", id: "ext" }],
  pdfPath: "N:\\secret\\body.pdf", customFields: [{ key: "notes", value: "not bibliography" }],
  tags: [], readingStatus: "unread", schemaVersion: 2, createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z", ...overrides
});

function reset() {
  rows.clear(); calls.reads.length = 0; calls.saves.length = 0;
  desktop = true; saveResponse = { saved: true, filePath: "N:\\B7\\citation.csl.json", message: "saved" };
}

test("canonical multi read is ordered, deterministic, literal and keeps duplicate DOI records", async () => {
  reset();
  const first = source("one", "中文 \"Ω\"");
  const second = source("two", "Another", { authors: [{ name: "研究组" }], year: undefined, doi: first.doi });
  rows.set("one", first); rows.set("two", second);
  const prepared = await service.prepare(["two", "one"]);
  assert.deepEqual(calls.reads, ["two", "one"]);
  assert.equal(prepared.selectedCount, 2); assert.equal(prepared.includedCount, 2); assert.equal(prepared.omittedCount, 0);
  const parsed = JSON.parse(prepared.contents);
  assert.deepEqual(parsed.map((item) => item.id), ["two", "one"]);
  assert.equal(parsed[0].DOI, parsed[1].DOI);
  assert.deepEqual(parsed[1].author, [{ literal: "Ada Example" }]);
  assert.equal(parsed[1].abstract, first.abstract);
  assert.deepEqual(parsed[1].issued, { "date-parts": [[2024]] });
  assert.equal(parsed[0].issued, undefined);
  assert.equal(parsed[1].pdfPath, undefined);
  assert.ok(!prepared.contents.includes("secret"));
  assert.ok(!prepared.contents.includes("0000-0000"));
  assert.ok(!prepared.contents.includes("not bibliography"));
  assert.deepEqual(await service.prepare(["two", "one"]), prepared);
  first.title = "Changed after preparation";
  await service.save(prepared);
  assert.equal(calls.saves.length, 1);
  assert.equal(calls.saves[0][1], prepared.contents);
  assert.deepEqual(calls.reads, ["two", "one", "two", "one"]);
});

test("title is optional by CSL schema; malformed selected row fails whole export without save", async () => {
  reset();
  rows.set("no-title", source("no-title", ""));
  const valid = await service.prepare(["no-title"]);
  assert.equal(JSON.parse(valid.contents)[0].title, undefined);
  assert.ok(valid.issues.some((issue) => issue.kind === "missing" && issue.field === "title"));
  rows.set("bad", source("bad", "Bad", { year: Number.NaN }));
  await assert.rejects(service.prepare(["no-title", "bad"]), (error) => {
    assert.ok(error instanceof CitationExportPreflightError);
    assert.ok(error.issues.some((issue) => issue.kind === "invalid" && issue.field === "year"));
    return true;
  });
  assert.equal(calls.saves.length, 0);
  await assert.rejects(service.prepare(["no-title", "missing"]), CitationExportPreflightError);
  await assert.rejects(service.prepare(["no-title", "no-title"]), CitationExportPreflightError);
  await assert.rejects(service.prepare([]), CitationExportPreflightError);
});

test("generic type, ambiguous keyword and unsupported venue are disclosed, without inference", async () => {
  reset();
  rows.set("other", source("other", "Other", {
    publicationType: "other", venue: "Archive", keywords: ["a,b"], authors: [],
    doi: undefined, url: undefined, abstract: undefined
  }));
  const prepared = await service.prepare(["other"]);
  const [item] = JSON.parse(prepared.contents);
  assert.equal(item.type, "document"); assert.equal(item["container-title"], undefined);
  assert.equal(item.keyword, undefined); assert.equal(item.author, undefined);
  assert.ok(prepared.issues.some((issue) => issue.kind === "unsupported" && issue.field === "venue"));
  assert.ok(prepared.issues.some((issue) => issue.kind === "unsupported" && issue.field === "keywords"));
  assert.ok(prepared.issues.some((issue) => issue.kind === "missing" && issue.field === "authors"));
  assert.equal(prepared.defaultFileName, "literature-citation.csl.json");
});

test("unexpected stored type cannot escape the official CSL type enum", async () => {
  reset(); rows.set("bad-type", source("bad-type", "Bad type", { publicationType: "__proto__" }));
  await assert.rejects(service.prepare(["bad-type"]), (error) => error instanceof CitationExportPreflightError
    && error.issues.some((issue) => issue.field === "publicationType" && issue.kind === "invalid"));
  assert.equal(calls.saves.length, 0);
});

test("save result truth: desktop guard, cancellation, native failure, no automatic retry", async () => {
  reset(); rows.set("one", source("one", "One"));
  const prepared = await service.prepare(["one"]);
  desktop = false;
  await assert.rejects(service.save(prepared), /desktop app/);
  assert.equal(calls.saves.length, 0);
  desktop = true;
  saveResponse = { saved: false, message: "Export cancelled." };
  assert.equal((await service.save(prepared)).saved, false);
  saveResponse = { saved: true, message: "Browser download started" };
  await assert.rejects(service.save(prepared), /did not confirm/);
  globalThis.__b7save = async (...args) => { calls.saves.push(args); throw Error("filesystem failure"); };
  await assert.rejects(service.save(prepared), /filesystem failure/);
  assert.equal(calls.saves.length, 3);
  assert.deepEqual(calls.reads, ["one"]);
});
