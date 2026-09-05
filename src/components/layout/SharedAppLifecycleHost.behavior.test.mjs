import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const directory = path.dirname(fileURLToPath(import.meta.url));
const bundle = await build({
  stdin: {
    contents: [
      'export { installNativeSharedEditorLifecycleCloseGuard } from "./SharedAppLifecycleHost.tsx";',
      'export { createSharedEditorLifecycleController } from "../../services/sharedEditorLifecycleController.ts";'
    ].join("\n"),
    resolveDir: directory,
    sourcefile: "shared-app-lifecycle-host-harness.ts"
  },
  plugins: [{
    name: "lifecycle-host-stubs",
    setup(esbuild) {
      esbuild.onResolve({ filter: /sharedManuscriptSessionComposition$/u }, () => ({ path: "composition", namespace: "stub" }));
      esbuild.onLoad({ filter: /^composition$/u, namespace: "stub" }, () => ({ contents: "export const sharedManuscriptSessionRuntime = { listSessions: () => [] };" }));
    }
  }],
  bundle: true,
  external: ["react", "@tauri-apps/api/window"],
  write: false,
  format: "cjs",
  platform: "node",
  target: "es2022"
});
const harnessModule = { exports: {} };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(
  createRequire(import.meta.url),
  harnessModule,
  harnessModule.exports
);
const {
  createSharedEditorLifecycleController,
  installNativeSharedEditorLifecycleCloseGuard
} = harnessModule.exports;

function dirtySession() {
  return {
    sessionKey: "native-session",
    sessionGeneration: 1,
    logicalIdentity: {
      ownerType: "review",
      ownerId: "review-1",
      channel: "primary",
      windowRole: "current",
      fileRefId: "file-1"
    },
    dirty: true
  };
}

test("native close settles one exact session and consumes one final-destroy permit", async () => {
  let session = dirtySession();
  const controller = createSharedEditorLifecycleController({
    listSessions: () => [session],
    createId: (() => { let id = 0; return () => `native-${++id}`; })()
  });
  controller.register({
    participantId: "review-current:native-session",
    handle: "native-session",
    presentationEpoch: 1,
    readSession: () => session,
    async save() { session = { ...session, dirty: false }; },
    async discard() { session = { ...session, dirty: false }; }
  });
  controller.markActive("review-current:native-session");

  let closeHandler;
  let destroyCalls = 0;
  const nativeWindow = {
    async onCloseRequested(handler) {
      closeHandler = handler;
      return () => {};
    },
    async destroy() {
      destroyCalls += 1;
    }
  };
  await installNativeSharedEditorLifecycleCloseGuard(nativeWindow, controller);

  let firstEventPrevented = false;
  await closeHandler({ preventDefault() { firstEventPrevented = true; } });
  assert.equal(firstEventPrevented, true);
  assert.equal(destroyCalls, 0);
  assert.equal(controller.getSnapshot().request?.continuationIntent, "APP_EXIT");

  await controller.resolve(controller.getSnapshot().request.requestToken, "discard");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(destroyCalls, 1);
  assert.equal(controller.getSnapshot().finalClosePermitArmed, false);
});

test("native multi-dirty close is active-first, blocks on save failure or cancel, and exits once after full settlement", async () => {
  const sessions = [
    {
      ...dirtySession(),
      sessionKey: "native-current-a",
      logicalIdentity: {
        ...dirtySession().logicalIdentity,
        ownerId: "review-a",
        fileRefId: "file-a"
      }
    },
    {
      ...dirtySession(),
      sessionKey: "native-independent-b",
      logicalIdentity: {
        ...dirtySession().logicalIdentity,
        ownerId: "review-b",
        windowRole: "independent",
        fileRefId: "file-b"
      }
    },
    {
      ...dirtySession(),
      sessionKey: "native-current-c",
      logicalIdentity: {
        ...dirtySession().logicalIdentity,
        ownerId: "review-c",
        fileRefId: "file-c"
      }
    }
  ];
  const controller = createSharedEditorLifecycleController({
    listSessions: () => sessions,
    createId: (() => { let id = 0; return () => `native-multi-${++id}`; })()
  });
  let failReviewBSave = true;
  for (const [index, session] of sessions.entries()) {
    controller.register({
      participantId: `native-participant-${index}`,
      handle: session.sessionKey,
      presentationEpoch: 1,
      readSession: () => session,
      async save() {
        if (session.logicalIdentity.ownerId === "review-b" && failReviewBSave) {
          throw new Error("NATIVE_SAVE_FAILED");
        }
        session.dirty = false;
      },
      async discard() { session.dirty = false; }
    });
  }
  controller.markActive("native-participant-1");

  let closeHandler;
  let destroyCalls = 0;
  const nativeWindow = {
    async onCloseRequested(handler) {
      closeHandler = handler;
      return () => {};
    },
    async destroy() {
      destroyCalls += 1;
    }
  };
  await installNativeSharedEditorLifecycleCloseGuard(nativeWindow, controller);

  await closeHandler({ preventDefault() {} });
  assert.equal(controller.getSnapshot().request.identity.ownerId, "review-b");
  const failed = await controller.resolve(
    controller.getSnapshot().request.requestToken,
    "save"
  );
  assert.equal(failed.status, "failed");
  assert.equal(destroyCalls, 0);
  assert.equal(sessions[1].dirty, true);
  await controller.resolve(controller.getSnapshot().request.requestToken, "cancel");
  assert.equal(controller.getSnapshot().request, undefined);
  assert.equal(destroyCalls, 0);

  failReviewBSave = false;
  await closeHandler({ preventDefault() {} });
  assert.equal(controller.getSnapshot().request.identity.ownerId, "review-b");
  await controller.resolve(controller.getSnapshot().request.requestToken, "save");
  assert.equal(controller.getSnapshot().request.identity.ownerId, "review-a");
  await controller.resolve(controller.getSnapshot().request.requestToken, "discard");
  assert.equal(controller.getSnapshot().request.identity.ownerId, "review-c");
  await controller.resolve(controller.getSnapshot().request.requestToken, "save");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(destroyCalls, 1);
  assert.equal(controller.getSnapshot().request, undefined);
  assert.equal(controller.getSnapshot().finalClosePermitArmed, false);
});

test("native destroy rejection revokes the one-shot final-close permit", async () => {
  const controller = createSharedEditorLifecycleController({
    listSessions: () => [],
    createId: (() => { let id = 0; return () => `native-reject-${++id}`; })()
  });
  let closeHandler;
  let destroyCalls = 0;
  const nativeWindow = {
    async onCloseRequested(handler) {
      closeHandler = handler;
      return () => {};
    },
    async destroy() {
      destroyCalls += 1;
      throw new Error("NATIVE_DESTROY_REJECTED");
    }
  };
  await installNativeSharedEditorLifecycleCloseGuard(nativeWindow, controller);

  let prevented = false;
  await closeHandler({ preventDefault() { prevented = true; } });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(prevented, true);
  assert.equal(destroyCalls, 1);
  assert.equal(controller.getSnapshot().finalClosePermitArmed, false);
});
