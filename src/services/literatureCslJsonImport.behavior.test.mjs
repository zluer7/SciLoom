import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: [path.resolve("src/services/literatureCslJsonImport.ts")],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  target: "es2022"
});
const parser = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);
const fixture = await readFile(
  path.resolve("src/services/fixtures/sc3-a2-a0-csl-json.json"),
  "utf8"
);

// Structure and fields follow citeproc-js's CSL-JSON item documentation:
// https://citeproc-js.readthedocs.io/en/latest/csl-json/markup.html
// Zotero documents CSL JSON as an import/export format:
// https://www.zotero.org/support/dev/data_formats
test("standard array maps ordered authors, Unicode and bounded metadata without attachment text", () => {
  const result = parser.preflightLiteratureCslJson(fixture);
  assert.equal(result.ok, true);
  assert.equal(result.entries.length, 4);
  const [article, book, fallback, invalid] = result.entries;
  assert.equal(article.status, "warning");
  assert.equal(article.input.title, "SC3 A2 A0 Synthetic Research Article");
  assert.deepEqual(article.input.authors.map((author) => author.name), ["Ada Example", "Lin Sample"]);
  assert.equal(article.input.year, 2024);
  assert.equal(article.input.publicationType, "journal_article");
  assert.equal(article.input.doi, "10.0000/sc3-a2-a0.synthetic");
  assert.deepEqual(article.input.keywords, ["methods", "reproducibility"]);
  assert.equal(article.input.externalIds[0].id, "sc3-a2-a0-article");
  assert.equal(article.input.id, undefined);
  assert.ok(article.ignoredFields.includes("volume"));
  assert.deepEqual(book.input.authors.map((author) => author.name), ["示例研究组", "明 李"]);
  assert.equal(book.input.year, 2022);
  assert.equal(book.input.doi, undefined);
  assert.equal(book.input.url, "https://example.org/sc3-a2-a0-book");
  assert.ok(book.ignoredFields.includes("note"));
  assert.equal(fallback.input.publicationType, "other");
  assert.equal(fallback.input.year, undefined);
  assert.ok(fallback.ignoredFields.includes("attachment"));
  assert.ok(fallback.ignoredFields.includes("annote"));
  assert.equal(fallback.input.pdfPath, undefined);
  assert.equal(fallback.input.localFilePath, undefined);
  assert.equal(invalid.status, "invalid");
  assert.equal(invalid.input, undefined);
  assert.ok(invalid.errors.some((entry) => entry.includes("标题")));
  assert.ok(!JSON.stringify(result).includes("This note must not be imported"));
  assert.ok(!JSON.stringify(result).includes("Annotation body must not be imported"));
});

test("malformed and unsupported wrappers are rejected before CREATE", () => {
  assert.deepEqual(parser.preflightLiteratureCslJson("{"), {
    ok: false, code: "parse", message: "JSON 解析失败；请选择有效的 CSL JSON 文件。"
  });
  assert.equal(parser.preflightLiteratureCslJson('{"items":[]}').code, "unsupported");
  assert.equal(parser.preflightLiteratureCslJson("[]").code, "structure");
  assert.equal(parser.preflightLiteratureCslJson('[{"id":"x","type":"book"}]').code, "structure");
});

test("source ids remain metadata and do not introduce an importer duplicate rule", () => {
  const result = parser.preflightLiteratureCslJson(JSON.stringify([
    { id: "same", type: "book", title: "A", DOI: "10.1234/a" },
    { id: "same", type: "book", title: "B", DOI: "10.1234/b" }
  ]));
  assert.equal(result.ok, true);
  assert.equal(result.entries[0].status, "ready");
  assert.equal(result.entries[1].status, "ready");
  assert.equal(result.entries[0].input.id, undefined);
  assert.equal(result.entries[1].input.id, undefined);
});
