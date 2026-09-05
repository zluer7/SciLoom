import assert from "node:assert/strict";
import test from "node:test";

import {
  SHARED_CURRENT_PROJECT_SELECTION_KEY,
  clearSharedCurrentProjectSelection,
  readSharedCurrentProjectSelection,
  resolveSharedCurrentProjectSelection,
  writeSharedCurrentProjectSelection
} from "./sharedCurrentProjectSelection.ts";

function createStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    }
  };
}

const projects = [{ id: "project-a" }, { id: "project-b" }];

test("concrete selection persists and is restored across remount or refresh reads", () => {
  const storage = createStorage();
  assert.equal(writeSharedCurrentProjectSelection("project-b", storage), "project-b");
  assert.equal(readSharedCurrentProjectSelection(storage), "project-b");
  assert.equal(resolveSharedCurrentProjectSelection(projects, storage), "project-b");
  assert.equal(resolveSharedCurrentProjectSelection([...projects], storage), "project-b");
});

test("ALL, null-equivalent, and whitespace selections never overwrite concrete shared state", () => {
  const storage = createStorage({
    [SHARED_CURRENT_PROJECT_SELECTION_KEY]: "project-a"
  });
  assert.equal(writeSharedCurrentProjectSelection("", storage), "project-a");
  assert.equal(writeSharedCurrentProjectSelection("   ", storage), "project-a");
  assert.equal(readSharedCurrentProjectSelection(storage), "project-a");
});

test("invalid stored identity falls back in current stable project order and rewrites preference", () => {
  const storage = createStorage({
    [SHARED_CURRENT_PROJECT_SELECTION_KEY]: "project-deleted"
  });
  assert.equal(resolveSharedCurrentProjectSelection(projects, storage), "project-a");
  assert.equal(readSharedCurrentProjectSelection(storage), "project-a");
});

test("no-project state clears stale identity and remains empty", () => {
  const storage = createStorage({
    [SHARED_CURRENT_PROJECT_SELECTION_KEY]: "project-deleted"
  });
  assert.equal(resolveSharedCurrentProjectSelection([], storage), "");
  assert.equal(readSharedCurrentProjectSelection(storage), null);
  clearSharedCurrentProjectSelection(storage);
  assert.equal(readSharedCurrentProjectSelection(storage), null);
});
