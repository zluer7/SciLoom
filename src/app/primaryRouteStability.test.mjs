import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import React, { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

const root = process.cwd();
const read = (relativePath) => readFile(path.join(root, relativePath), "utf8");
const primaryPages = [
  ["projects", "ProjectsPage"],
  ["routes", "RoutesPage"],
  ["tasks", "TasksPage"],
  ["experiments", "ExperimentsPage"],
  ["literature", "LiteraturePage"],
  ["reviews", "ReviewsPage"],
  ["outputs", "OutputsPage"],
  ["settings", "SettingsPage"]
];

test("all primary routes and Global AI use static imports", async () => {
  const routesSource = await read("src/app/routes.tsx");
  const appLayoutSource = await read("src/components/layout/AppLayout.tsx");
  for (const [route, component] of primaryPages) {
    assert.match(routesSource, new RegExp(`import \\{ ${component} \\} from`));
    assert.match(routesSource, new RegExp(`path: ["']${route}["'][^\\n]*element: <${component} />`));
  }
  assert.doesNotMatch(routesSource, /\blazy\s*:/u);
  assert.match(routesSource, /path:\s*["']\*["'][^\n]*element:/u);
  assert.match(appLayoutSource, /import\s+\{\s*GlobalAIChatPanel\s*\}\s+from/u);
  assert.doesNotMatch(appLayoutSource, /\blazy\s*\(|<Suspense/u);
});

test("low-frequency shared segment product host keeps a guarded visible lazy boundary", async () => {
  const lazyEditorSource = await read("src/components/common/LazyManuscriptSegmentEditorWindow.tsx");
  const boundarySource = await read("src/components/common/LazyComponentBoundary.tsx");
  assert.match(lazyEditorSource, /lazy\s*\(\s*async[\s\S]*import\(["'].\/ManuscriptSegmentEditorWindow["']\)/u);
  assert.match(boundarySource, /<Suspense\s+fallback=\{<section[^>]+role=["']status["'][^>]*>\{loadingMessage\}<\/section>\}>/u);
  assert.match(boundarySource, /getDerivedStateFromError|componentDidCatch/u);
  assert.match(boundarySource, /role=["'](?:status|alert)["']/u);
  assert.doesNotMatch(boundarySource, /fallback=\{null\}/u);
  for (const pagePath of [
    "src/pages/Literature/LiteraturePage.tsx",
    "src/pages/Reviews/ReviewsPage.tsx",
    "src/pages/Outputs/OutputsPage.tsx"
  ]) {
    const pageSource = await read(pagePath);
    assert.match(pageSource, /LazyManuscriptSegmentEditorWindow/u);
    assert.doesNotMatch(pageSource, /LazyMarkdownEditorWindow|from\s+["'][^"']*\/MarkdownEditorWindow["']/u);
  }
});

const pageStubNames = new Map(primaryPages.map(([, component]) => [`${component}.tsx`, component]));
const bundle = await build({
  stdin: {
    contents: `
      import React from "react";
      import { MemoryRouter, useRoutes } from "react-router-dom";
      import { routes } from "./routes.tsx";
      export function RouteHarness({ initialEntry }) {
        function RoutedContent() { return useRoutes(routes); }
        return React.createElement(
          MemoryRouter,
          {
            initialEntries: [initialEntry],
            future: { v7_startTransition: true, v7_relativeSplatPath: true }
          },
          React.createElement(RoutedContent)
        );
      }
    `,
    resolveDir: path.join(root, "src/app"),
    sourcefile: "primary-route-harness.tsx"
  },
  plugins: [{
    name: "primary-route-runtime-stubs",
    setup(esbuild) {
      esbuild.onResolve({ filter: /components[\\/]layout[\\/]AppLayout$/u }, () => ({ path: "app-layout", namespace: "stub" }));
      esbuild.onLoad({ filter: /^app-layout$/u, namespace: "stub" }, () => ({
        loader: "tsx",
        contents: `
          import React from "react";
          import { Outlet } from "react-router-dom";
          export function AppLayout() {
            return <div data-app-shell="true"><main className="main-content"><Outlet /></main></div>;
          }
        `
      }));
      esbuild.onResolve({ filter: /pages[\\/].*[\\/](?:ProjectsPage|RoutesPage|TasksPage|ExperimentsPage|LiteraturePage|ReviewsPage|OutputsPage|SettingsPage)$/u }, (args) => ({
        path: `${path.basename(args.path)}.tsx`,
        namespace: "page-stub"
      }));
      esbuild.onLoad({ filter: /Page\.tsx$/u, namespace: "page-stub" }, (args) => {
        const component = pageStubNames.get(args.path);
        if (!component) throw new Error(`Unexpected page stub: ${args.path}`);
        const route = primaryPages.find(([, name]) => name === component)?.[0];
        return {
          loader: "tsx",
          contents: `import React from "react"; export function ${component}() { return <section data-primary-page="${route}">${component}</section>; }`
        };
      });
    }
  }],
  bundle: true,
  external: ["react", "react-router-dom"],
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
const { RouteHarness } = harnessModule.exports;

const boundaryBundle = await build({
  stdin: {
    contents: 'export { LazyComponentBoundary } from "./LazyComponentBoundary.tsx";',
    resolveDir: path.join(root, "src/components/common"),
    sourcefile: "lazy-boundary-harness.tsx"
  },
  bundle: true,
  external: ["react"],
  write: false,
  format: "cjs",
  platform: "node",
  target: "es2022"
});
const boundaryModule = { exports: {} };
new Function("require", "module", "exports", boundaryBundle.outputFiles[0].text)(
  createRequire(import.meta.url),
  boundaryModule,
  boundaryModule.exports
);
const { LazyComponentBoundary } = boundaryModule.exports;

test("lazy component boundary renders visible loading feedback", async () => {
  const Pending = React.lazy(() => new Promise(() => {}));
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(createElement(
      LazyComponentBoundary,
      {
        loadingMessage: "正在加载组件…",
        errorMessage: "组件加载失败。",
        retryLabel: "重新加载"
      },
      createElement(Pending)
    ));
  });
  assert.equal(renderer.root.findByProps({ role: "status" }).children.join(""), "正在加载组件…");
});

test("lazy component boundary renders a local error instead of blank content", async () => {
  const Broken = React.lazy(() => Promise.reject(new Error("simulated chunk failure")));
  const previousConsoleError = console.error;
  console.error = () => {};
  let renderer;
  try {
    await act(async () => {
      renderer = TestRenderer.create(createElement(
        LazyComponentBoundary,
        {
          loadingMessage: "正在加载组件…",
          errorMessage: "组件加载失败。",
          retryLabel: "重新加载"
        },
        createElement(Broken)
      ));
      await Promise.resolve();
    });
  } finally {
    console.error = previousConsoleError;
  }
  const alert = renderer.root.findByProps({ role: "alert" });
  assert.match(alert.findByType("p").children.join(""), /组件加载失败/u);
  assert.equal(alert.findByType("button").children.join(""), "重新加载");
});

for (const [route] of primaryPages) {
  test(`mounted /${route} route renders a non-empty ${route} page`, async () => {
    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(RouteHarness, { initialEntry: `/${route}` }));
    });
    assert.equal(renderer.root.findAllByProps({ "data-primary-page": route }).length, 1);
    assert.ok(renderer.root.findByType("main").children.length > 0);
  });
}

test("an unmatched route renders an explicit non-empty error", async () => {
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(createElement(RouteHarness, { initialEntry: "/missing" }));
  });
  const main = renderer.root.findByType("main");
  assert.ok(main.children.length > 0);
  assert.equal(main.findAllByProps({ role: "alert" }).length, 1);
});
