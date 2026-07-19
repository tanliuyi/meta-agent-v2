import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const verifier = resolve(import.meta.dirname, "../../../scripts/verify-desktop-renderer-boundaries.mjs");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "desktop-renderer-boundaries-"));
  roots.push(root);
  await Promise.all(
    Object.entries(files).map(async ([path, content]) => {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }),
  );
  return root;
}

function verify(root: string) {
  return spawnSync(process.execPath, [verifier, "--root", root, root], { encoding: "utf8" });
}

function cssSystemFiles(overrides: Readonly<Record<string, string>> = {}): Readonly<Record<string, string>> {
  return {
    "styles.css": '@import "./styles/index.css";',
    "styles/index.css": [
      "@layer theme, base, components, utilities, overrides;",
      '@import "./tokens.css";',
      '@import "./base.css";',
      '@import "./components.css" layer(components);',
      '@import "./layout.css" layer(components);',
      '@import "./chat.css" layer(components);',
      '@import "./markdown.css" layer(components);',
      '@import "./panel.css" layer(components);',
      '@import "./utilities.css";',
      '@import "./overrides.css" layer(overrides);',
    ].join("\n"),
    "styles/tokens.css": "@layer theme { :root { --foreground: 0 0% 10%; } }",
    "styles/base.css": [
      "@layer base {",
      "  @media (forced-colors: active) {",
      "    button:focus-visible { outline: 2px solid Highlight !important; }",
      "  }",
      "}",
    ].join("\n"),
    "styles/components.css": ".menu-item.danger { color: hsl(var(--foreground)); }",
    "styles/layout.css": ".layout { color: hsl(var(--foreground)); }",
    "styles/chat.css": '.chat[data-state="open"] { color: hsl(var(--foreground)); }',
    "styles/markdown.css": ".markdown { color: hsl(var(--foreground)); }",
    "styles/panel.css": ".panel { color: hsl(var(--foreground)); }",
    "styles/utilities.css": "@layer utilities {}",
    "styles/overrides.css": [
      "/* 移除条件：第三方包装节点允许直接配置尺寸。 */",
      ".viewport > div { min-width: 0 !important; }",
    ].join("\n"),
    ...overrides,
  };
}

describe("Desktop renderer boundary verifier", () => {
  it("accepts one component per file and forward-only feature imports", async () => {
    const root = await fixture({
      "features/settings/settings-page.tsx": [
        'import { ErrorToast } from "@renderer/shared/ui/error-toast";',
        'import Search from "lucide-react/dist/esm/icons/search.mjs";',
        "export function SettingsPage() {",
        '  return <><Search /><ErrorToast message="error" onDismiss={() => undefined} /></>;',
        "}",
      ].join("\n"),
      "shared/ui/dialog.tsx": [
        'import * as DialogPrimitive from "@radix-ui/react-dialog";',
        "export const Dialog = DialogPrimitive.Root;",
      ].join("\n"),
      "shared/ui/error-toast.tsx": "export function ErrorToast() { return <div />; }",
    });

    const result = verify(root);

    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects multiple and nested components", async () => {
    const root = await fixture({
      "features/chat/multiple.tsx": [
        "export function First() { return <div />; }",
        "export const Second = () => <span />;",
      ].join("\n"),
      "features/chat/nested.tsx": [
        "export function Outer() {",
        "  function Inner() { return <span />; }",
        "  return <Inner />;",
        "}",
      ].join("\n"),
      "shared/ui/primitive-parts.tsx": [
        'import * as DialogPrimitive from "@radix-ui/react-dialog";',
        "export const Dialog = DialogPrimitive.Root;",
        "export const DialogTrigger = DialogPrimitive.Trigger;",
      ].join("\n"),
      "features/chat/null-components.tsx": [
        "export function FirstNull() { return null; }",
        "export const SecondNull = () => null;",
      ].join("\n"),
      "features/chat/anonymous-default-function.tsx": [
        "export function NamedFunction() { return <div />; }",
        "export default function () { return null; }",
      ].join("\n"),
      "features/chat/anonymous-default-arrow.tsx": [
        "export function NamedArrow() { return <div />; }",
        "export default () => null;",
      ].join("\n"),
      "features/chat/aliased-wrapper.tsx": [
        'import { memo as reactMemo } from "react";',
        "export function AliasedFirst() { return <div />; }",
        "export const AliasedSecond = reactMemo(() => null);",
      ].join("\n"),
      "features/chat/namespace-wrapper.tsx": [
        'import * as ReactRuntime from "react";',
        "export const NamespaceFirst = ReactRuntime.forwardRef(() => null);",
        "export const NamespaceSecond = ReactRuntime.lazy(() => Promise.resolve({ default: () => null }));",
      ].join("\n"),
      "features/chat/default-wrapper.tsx": [
        'import ReactRuntime from "react";',
        "export function DefaultFirst() { return <div />; }",
        "export const DefaultSecond = ReactRuntime.memo(() => null);",
      ].join("\n"),
    });

    const result = verify(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("one component per file; found First, Second");
    expect(result.stderr).toContain("one component per file; found Dialog, DialogTrigger");
    expect(result.stderr).toContain("one component per file; found FirstNull, SecondNull");
    expect(result.stderr).toContain("one component per file; found NamedFunction, default export");
    expect(result.stderr).toContain("one component per file; found NamedArrow, default export");
    expect(result.stderr).toContain("one component per file; found AliasedFirst, AliasedSecond");
    expect(result.stderr).toContain("one component per file; found NamespaceFirst, NamespaceSecond");
    expect(result.stderr).toContain("one component per file; found DefaultFirst, DefaultSecond");
    expect(result.stderr).toContain("nested React component Inner is not allowed");
  });

  it("does not treat ordinary local wrapper names as React component wrappers", async () => {
    const root = await fixture({
      "features/chat/local-wrappers.tsx": [
        "const memo = <T,>(value: T) => value;",
        "const forwardRef = <T,>(value: T) => value;",
        "const lazy = <T,>(value: T) => value;",
        "const MemoResult = memo(1);",
        "const ForwardRefResult = forwardRef(2);",
        "const LazyResult = lazy(3);",
        "export function OnlyComponent() { return <div />; }",
      ].join("\n"),
    });

    const result = verify(root);

    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects reverse runtime dependencies", async () => {
    const root = await fixture({
      "runtime/pi/runtime.ts": 'import { state } from "../../state/desktop/state.ts"; export const runtime = state;',
      "runtime/pi/reexport.ts": 'export { state } from "../../state/desktop/state.ts";',
      "runtime/pi/dynamic.ts": 'export const load = () => import("../../state/desktop/state.ts");',
      "state/desktop/state.ts": "export const state = 1;",
    });

    const result = verify(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("runtime must not import state");
    expect(result.stderr.match(/runtime must not import state/g)).toHaveLength(3);
  });

  it("rejects reverse component dependencies", async () => {
    const root = await fixture({
      "components/chat/thread.tsx": [
        'import { SettingsPage } from "../../features/settings/settings-page.tsx";',
        "export function Thread() { return <SettingsPage />; }",
      ].join("\n"),
      "features/settings/settings-page.tsx": "export function SettingsPage() { return <div />; }",
    });

    const result = verify(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("components must not import features");
  });

  it("restricts the renderer entry and rejects unowned top-level source", async () => {
    const root = await fixture({
      "main.tsx": 'import { state } from "@renderer/state/desktop-state"; void state;',
      "state/desktop-state.ts": "export const state = 1;",
      "lib/unowned.ts": "export const unowned = true;",
    });

    const result = verify(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("main must not import state");
    expect(result.stderr).toContain(
      "renderer source must live in main.tsx or an app/components/features/runtime/shared/state layer",
    );
  });

  it("rejects runtime imports from known heavy package barrels", async () => {
    const root = await fixture({
      "components/icons.tsx": [
        'import { Search } from "lucide-react";',
        'import * as icons from "lucide-react/dist/esm/icons/index.mjs";',
        'import * as lucide from "lucide-react/dist/esm/lucide-react.mjs";',
        'import { Dialog } from "radix-ui";',
        "export function Icons() { void icons; void lucide; return <><Search /><Dialog.Root /></>; }",
      ].join("\n"),
    });

    const result = verify(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("package barrel lucide-react is not allowed");
    expect(result.stderr).toContain("package barrel lucide-react/dist/esm/icons/index.mjs is not allowed");
    expect(result.stderr).toContain("package barrel lucide-react/dist/esm/lucide-react.mjs is not allowed");
    expect(result.stderr).toContain("package barrel radix-ui is not allowed");
  });

  it("rejects pure and aggregate re-export barrels with non-index filenames", async () => {
    const root = await fixture({
      "components/chat/first.ts": "export const first = 1;",
      "components/chat/second.ts": "export const second = 2;",
      "components/chat/pure-proxy.ts": 'export { first } from "./first.ts";',
      "components/chat/aggregate-proxy.ts": [
        "export const owned = true;",
        'export { first } from "./first.ts";',
        'export { second } from "./second.ts";',
      ].join("\n"),
    });

    const result = verify(root);

    expect(result.status).toBe(1);
    expect(result.stderr.match(/renderer re-export barrel files are not allowed/g)).toHaveLength(2);
  });

  it("accepts the documented renderer CSS token and layer system", async () => {
    const root = await fixture(cssSystemFiles());

    const result = verify(root);

    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects CSS ownership, color, important, and state contract violations", async () => {
    const root = await fixture(
      cssSystemFiles({
        "styles.css": '@import "./styles/index.css";\nbody {}',
        "styles/base.css": "@layer base { button { outline: none !important; } }",
        "styles/chat.css": ".tool.error { color: #fff; }",
        "styles/components.css": ".bad { color: red !important; }",
        "styles/overrides.css": ".viewport > div { min-width: 0 !important; }",
        "styles/rogue.css": ".rogue { color: hsl(var(--foreground)); }",
        "components/palette.tsx": 'export function Palette() { return <div className="bg-red-500 ring-0!" />; }',
      }),
    );

    const result = verify(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("renderer CSS root must only import ./styles/index.css");
    expect(result.stderr).toContain("CSS color literal #fff is not allowed outside tokens.css");
    expect(result.stderr).toContain("CSS state modifier .tool.error is not allowed");
    expect(result.stderr).toContain("!important is only allowed inside accessibility media queries in base.css");
    expect(result.stderr).toContain("!important is only allowed for reduced motion or documented overrides");
    expect(result.stderr).toContain("overrides using !important require an adjacent 移除条件 comment");
    expect(result.stderr).toContain("renderer CSS file has no documented layer ownership");
    expect(result.stderr).toContain("Tailwind fixed palette bg-red-500 is not allowed");
    expect(result.stderr).toContain("Tailwind important utility ring-0! is not allowed");
  });
});
