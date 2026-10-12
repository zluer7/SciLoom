import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const bundle = await build({
  entryPoints: [resolve("src/components/ai/AIContextPreviewPanel.tsx")],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  target: "es2022",
  jsx: "automatic",
  external: ["react", "react/jsx-runtime"],
  plugins: [{
    name: "context-projection-stub",
    setup(api) {
      api.onResolve({ filter: /aiContextPreviewDisplayService$/u }, () => ({
        path: "context-projection",
        namespace: "test-stub"
      }));
      api.onLoad({ filter: /.*/u, namespace: "test-stub" }, () => ({
        contents: "export const buildAIContextLevelViewerProjection = () => ({ levelGroups: [], unclassifiedItems: [] });"
      }));
    }
  }]
});
const module = { exports: {} };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(
  createRequire(import.meta.url), module, module.exports
);
const { AIContextPreviewPanel } = module.exports;

function props(mode, callbacks) {
  return {
    contextPackage: {
      id: "test-package",
      version: 1,
      reviewFingerprint: "test-fingerprint",
      scope: { label: "测试课题" },
      researchObjects: [],
      materialDecisions: [],
      warnings: []
    },
    contextMarkdown: "# Builder original\n",
    defaultContextMarkdown: "# Builder original\n",
    isContextModified: false,
    disabled: false,
    mode,
    onDirtyChange: () => {},
    onEdit: () => callbacks.push("edit"),
    onReselect: () => callbacks.push("reselect"),
    onSaveContext: (text) => callbacks.push(["save", text]),
    onExport: (text) => callbacks.push(["export", text]),
    onCancelEdit: () => callbacks.push("cancel"),
    onConfirm: () => callbacks.push("confirm")
  };
}

function button(root, label) {
  return root.findAllByType("button").find((item) => item.children.join("") === label);
}

test("export in edit mode uses the latest unsaved textarea value without confirming or saving it", async () => {
  const callbacks = [];
  let renderer;
  await act(async () => { renderer = TestRenderer.create(React.createElement(AIContextPreviewPanel, props("edit", callbacks))); });
  const markdown = "  # 已编辑 Context\n**bold** & `code`\n用户路径 C:\\research\\note.md\n\n尾部空白  ";
  await act(async () => {
    renderer.root.findByType("textarea").props.onChange({ target: { value: markdown } });
  });
  await act(async () => { button(renderer.root, "导出").props.onClick(); });
  assert.deepEqual(callbacks, [["export", markdown]]);
  assert.equal(renderer.root.findByType("textarea").props.value, markdown);
  await act(async () => { button(renderer.root, "取消").props.onClick(); });
  assert.deepEqual(callbacks, [["export", markdown], "cancel"]);
  renderer.unmount();
});

test("view export uses current Markdown and existing actions keep their handlers", async () => {
  const callbacks = [];
  let renderer;
  await act(async () => { renderer = TestRenderer.create(React.createElement(AIContextPreviewPanel, props("view", callbacks))); });
  for (const label of ["导出", "重新选择对象", "编辑内容", "确认"]) {
    await act(async () => { button(renderer.root, label).props.onClick(); });
  }
  assert.deepEqual(callbacks, [["export", "# Builder original\n"], "reselect", "edit", "confirm"]);
  renderer.unmount();
});
