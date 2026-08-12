import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Select } from "../src/renderer/src/components/assistant-ui/select/select.tsx";
import { PluginConfigurationForm } from "../src/renderer/src/features/plugins/plugin-configuration-form.tsx";
import {
  PluginConfigurationJsonEditor,
  parsePluginConfigurationJson,
} from "../src/renderer/src/features/plugins/plugin-configuration-json-editor.tsx";
import type { PluginConfigurationController } from "../src/renderer/src/features/plugins/use-plugin-configuration.ts";
import { preparePluginConfigurationJsonDraft } from "../src/renderer/src/features/plugins/use-plugin-configuration.ts";
import type {
  PluginConfigurationField,
  PluginConfigurationSnapshot,
  PluginConfigurationValue,
} from "../src/shared/plugin-configuration-contracts.ts";

vi.mock("@radix-ui/react-select", () => {
  const stub = (name: string) =>
    function RadixStub({
      children,
      id,
      className,
      "aria-labelledby": ariaLabelledby,
      "aria-describedby": ariaDescribedby,
      "aria-invalid": ariaInvalid,
    }: {
      children?: ReactNode;
      id?: string;
      className?: string;
      "aria-labelledby"?: string;
      "aria-describedby"?: string;
      "aria-invalid"?: boolean;
    }) {
      return (
        <div
          data-radix-select={name}
          id={id}
          className={className}
          aria-labelledby={ariaLabelledby}
          aria-describedby={ariaDescribedby}
          aria-invalid={ariaInvalid}
        >
          {children}
        </div>
      );
    };
  return {
    Root: stub("root"),
    Trigger: stub("trigger"),
    Icon: stub("icon"),
    Portal: stub("portal"),
    Content: stub("content"),
    Viewport: stub("viewport"),
    Item: stub("item"),
    ItemText: stub("item-text"),
    ItemIndicator: stub("item-indicator"),
    ScrollUpButton: stub("scroll-up-button"),
    ScrollDownButton: stub("scroll-down-button"),
  };
});

vi.mock("../src/renderer/src/shared/ui/use-toast.ts", () => ({
  useToast: () => ({ notify: vi.fn(), update: vi.fn(), dismiss: vi.fn() }),
}));

const controllerState = vi.hoisted(() => ({
  snapshot: undefined as PluginConfigurationSnapshot | undefined,
  values: {} as Record<string, string | boolean>,
  effectiveValues: {} as Record<string, PluginConfigurationValue>,
  secretValues: {} as Record<string, string>,
  clearedSecrets: new Set<string>(),
  fieldErrors: new Map<string, string>(),
  resetField: vi.fn(),
  saveJsonValues: vi.fn(async () => true),
}));

vi.mock("../src/renderer/src/features/plugins/use-plugin-configuration.ts", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    usePluginConfiguration: () => ({
      snapshot: controllerState.snapshot,
      values: controllerState.values,
      effectiveValues: controllerState.effectiveValues,
      secretValues: controllerState.secretValues,
      clearedSecrets: controllerState.clearedSecrets,
      fieldErrors: controllerState.fieldErrors,
      loading: false,
      saving: false,
      dirty: true,
      error: undefined,
      notice: undefined,
      setValue: vi.fn(),
      setSecretValue: vi.fn(),
      clearSecret: vi.fn(),
      resetField: controllerState.resetField,
      save: vi.fn(async () => undefined),
      saveJsonValues: controllerState.saveJsonValues,
    }),
  };
});

function makeController(overrides: Partial<PluginConfigurationController> = {}): PluginConfigurationController {
  return {
    snapshot: undefined,
    values: {},
    effectiveValues: {},
    secretValues: {},
    clearedSecrets: new Set(),
    fieldErrors: new Map(),
    loading: false,
    saving: false,
    dirty: false,
    error: undefined,
    notice: undefined,
    setValue: vi.fn(),
    setSecretValue: vi.fn(),
    clearSecret: vi.fn(),
    resetField: vi.fn(),
    save: vi.fn(async () => undefined),
    saveJsonValues: vi.fn(async () => true),
    ...overrides,
  };
}

function renderForm(fields: PluginConfigurationField[]): string {
  controllerState.snapshot = {
    pluginId: "example.tools",
    revision: "rev-one",
    schema: { version: 1, fields },
    values: {},
    secrets: {},
    secretStorageAvailable: true,
  };
  return renderToStaticMarkup(<PluginConfigurationForm pluginId="example.tools" />);
}

describe("plugin configuration form", () => {
  it("sorts fields by order and wraps each group's heading and fields in a group container", () => {
    const markup = renderForm([
      { key: "apiKey", label: "API 密钥", type: "secret", group: "连接设置", order: 0 },
      { key: "host", label: "主机", type: "text", group: "连接设置", order: 1 },
      { key: "name", label: "名称", type: "text", order: 2 },
      {
        key: "mode",
        label: "模式",
        type: "select",
        group: "高级选项",
        order: 3,
        options: [{ value: "fast", label: "快速" }],
      },
      { key: "timeout", label: "超时", type: "number", group: "高级选项", order: 3 },
    ]);

    expect(markup.match(/<h4/g)).toHaveLength(2);
    expect(markup.match(/<div class="plugin-configuration-group">/g)).toHaveLength(2);
    const apiKey = markup.indexOf('id="plugin-configuration-apiKey"');
    const host = markup.indexOf('id="plugin-configuration-host"');
    const name = markup.indexOf('id="plugin-configuration-name"');
    const mode = markup.indexOf('id="plugin-configuration-mode"');
    const timeout = markup.indexOf('id="plugin-configuration-timeout"');
    const firstGroup = markup.indexOf('<div class="plugin-configuration-group">');
    const secondGroup = markup.lastIndexOf('<div class="plugin-configuration-group">');
    expect(apiKey).toBeGreaterThan(-1);
    expect(host).toBeGreaterThan(apiKey);
    expect(name).toBeGreaterThan(host);
    expect(mode).toBeGreaterThan(name);
    expect(timeout).toBeGreaterThan(mode);
    expect(firstGroup).toBeGreaterThan(-1);
    expect(markup.indexOf(">连接设置</h4>")).toBeGreaterThan(firstGroup);
    expect(apiKey).toBeGreaterThan(markup.indexOf(">连接设置</h4>"));
    expect(secondGroup).toBeGreaterThan(host);
    expect(secondGroup).toBeGreaterThan(name);
    expect(secondGroup).toBeLessThan(mode);
    expect(markup.indexOf(">高级选项</h4>")).toBeGreaterThan(secondGroup);
    expect(mode).toBeGreaterThan(markup.indexOf(">高级选项</h4>"));
    expect(markup.indexOf(">连接设置</h4>")).toBe(markup.lastIndexOf(">连接设置</h4>"));
    expect(markup.indexOf(">高级选项</h4>")).toBe(markup.lastIndexOf(">高级选项</h4>"));
  });

  it("shows a deprecated badge and message and keeps the field editable", () => {
    const markup = renderForm([
      {
        key: "legacy",
        label: "旧字段",
        type: "text",
        deprecated: true,
        deprecatedMessage: "请改用新字段",
        defaultValue: "x",
      },
    ]);

    expect(markup).toContain("已弃用");
    expect(markup).toContain("请改用新字段");
    expect(markup).toContain('data-deprecated="true"');
    expect(markup).toContain('id="plugin-configuration-legacy"');
    expect(markup).toContain('type="text"');
  });

  it("shows the reset button only when a default exists and the draft differs", () => {
    controllerState.snapshot = {
      pluginId: "example.tools",
      revision: "rev-one",
      schema: {
        version: 1,
        fields: [
          { key: "port", label: "端口", type: "number", defaultValue: 8080 },
          { key: "note", label: "备注", type: "text" },
          { key: "enabled", label: "启用", type: "boolean", defaultValue: false },
        ],
      },
      values: {},
      secrets: {},
      secretStorageAvailable: true,
    };
    controllerState.values = { port: "9090", note: "abc", enabled: true };
    let markup = renderToStaticMarkup(<PluginConfigurationForm pluginId="example.tools" />);
    expect(markup).toContain('aria-label="恢复端口的默认值"');
    expect(markup).toContain('title="恢复端口的默认值"');
    expect(markup).toContain('aria-label="恢复启用的默认值"');
    expect(markup).not.toContain("恢复备注的默认值");

    controllerState.values = { port: "8080", note: "abc", enabled: false };
    markup = renderToStaticMarkup(<PluginConfigurationForm pluginId="example.tools" />);
    expect(markup).not.toContain("恢复端口的默认值");
    expect(markup).not.toContain("恢复启用的默认值");
  });

  it("passes the pattern attribute to text and path inputs but not textarea or number", () => {
    const markup = renderForm([
      { key: "slug", label: "标识", type: "path", pattern: "[a-z-]+", defaultValue: "abc" },
      { key: "desc", label: "描述", type: "textarea", pattern: "x" },
      { key: "count", label: "数量", type: "number", pattern: "[0-9]+" },
    ]);

    expect(markup).toContain('pattern="[a-z-]+"');
    expect(markup).not.toContain('pattern="x"');
    expect(markup).not.toContain('pattern="[0-9]+"');
  });

  it("keeps the save button inside the heading actions container for a future mode toggle", () => {
    const markup = renderForm([{ key: "name", label: "名称", type: "text" }]);
    const actions = markup.indexOf('class="plugin-configuration-heading-actions"');
    expect(actions).toBeGreaterThan(-1);
    expect(markup.indexOf(">保存</button>")).toBeGreaterThan(actions);
  });

  it("renders a JSON mode toggle button next to save in the heading actions", () => {
    const markup = renderForm([{ key: "name", label: "名称", type: "text" }]);
    expect(markup).toContain('aria-label="切换到 JSON 编辑模式"');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain(">JSON</button>");
    const actions = markup.indexOf('class="plugin-configuration-heading-actions"');
    const toggle = markup.indexOf('aria-label="切换到 JSON 编辑模式"');
    const save = markup.indexOf(">保存</button>");
    expect(toggle).toBeGreaterThan(actions);
    expect(save).toBeGreaterThan(toggle);
    // 表单模式下不渲染 JSON 编辑器
    expect(markup).not.toContain('class="plugin-configuration-json-editor"');
    expect(markup).not.toContain('aria-label="插件配置 JSON"');
  });
});

describe("plugin configuration JSON editor", () => {
  const snapshot: PluginConfigurationSnapshot = {
    pluginId: "example.tools",
    revision: "rev-one",
    schema: {
      version: 1,
      fields: [
        { key: "host", label: "主机", type: "text", required: true },
        { key: "port", label: "端口", type: "number", defaultValue: 8080, minimum: 1024 },
        { key: "enabled", label: "启用", type: "boolean" },
        { key: "mode", label: "模式", type: "select", options: [{ value: "fast", label: "快速" }] },
        { key: "apiKey", label: "API 密钥", type: "secret" },
      ],
    },
    values: { port: 9090, enabled: true },
    secrets: {},
    secretStorageAvailable: true,
  };

  it("renders pretty-printed effective values in a monospace textarea with the secret note", () => {
    const controller = makeController({ snapshot, effectiveValues: { host: "default", port: 9090, enabled: true } });
    const markup = renderToStaticMarkup(<PluginConfigurationJsonEditor controller={controller} saveRequest={0} />);

    expect(markup).toContain('class="plugin-configuration-json-editor-textarea"');
    expect(markup).toContain('spellCheck="false"');
    const expected = JSON.stringify({ host: "default", port: 9090, enabled: true }, null, 2).replaceAll('"', "&quot;");
    expect(markup).toContain(expected);
    expect(markup).toContain("secret 字段不会在 JSON 模式中显示或修改（请在表单模式中管理敏感字段）");
    expect(markup).not.toContain('role="alert"');
  });

  it("reports JSON syntax errors and schema violations from the parser", () => {
    const schema = snapshot.schema;
    expect(parsePluginConfigurationJson("{", schema)).toEqual({
      ok: false,
      error: expect.stringContaining("JSON 语法错误"),
    });
    expect(parsePluginConfigurationJson("[1, 2]", schema)).toEqual({ ok: false, error: "JSON 配置必须是对象" });
    expect(parsePluginConfigurationJson('{"nope": "x"}', schema)).toEqual({
      ok: false,
      error: "JSON 配置包含未知字段：nope",
    });
    expect(parsePluginConfigurationJson('{"apiKey": "x"}', schema)).toEqual({
      ok: false,
      error: "字段 apiKey 是敏感字段，请在表单模式中管理",
    });
    expect(parsePluginConfigurationJson('{"host": {"nested": true}}', schema)).toEqual({
      ok: false,
      error: "字段 host 的值必须是文本、数字或开关值",
    });
    expect(parsePluginConfigurationJson('{"port": 1e999}', schema)).toEqual({
      ok: false,
      error: "字段 port 必须是有限数字",
    });
    expect(parsePluginConfigurationJson("{}", schema)).toEqual({ ok: false, error: "主机为必填项" });
    expect(parsePluginConfigurationJson('{"host": "a", "port": 1}', schema)).toEqual({
      ok: false,
      error: "端口不能小于 1024",
    });
    expect(parsePluginConfigurationJson('{"host": "a", "mode": "slow"}', schema)).toEqual({
      ok: false,
      error: "模式包含无效选项",
    });
    expect(parsePluginConfigurationJson('{"host": "a", "port": "8080"}', schema)).toEqual({
      ok: false,
      error: "端口必须是有限数字",
    });
  });

  it("accepts a valid JSON object and keeps scalar values", () => {
    const parsed = parsePluginConfigurationJson(
      JSON.stringify({ host: "a", port: 8080, enabled: false, mode: "fast" }),
      snapshot.schema,
    );
    expect(parsed).toEqual({
      ok: true,
      values: { host: "a", port: 8080, enabled: false, mode: "fast" },
    });
  });

  it("keeps fields omitted from JSON absent instead of restoring snapshot values", () => {
    expect(preparePluginConfigurationJsonDraft(snapshot, { host: "a" })).toEqual({
      ok: true,
      draft: { host: "a" },
    });
  });
});

describe("select option descriptions", () => {
  it("renders a muted description line inside the dropdown item when present", () => {
    const markup = renderToStaticMarkup(
      <Select
        value="fast"
        onValueChange={() => {}}
        options={[
          { value: "fast", label: "快速", description: "响应最快" },
          { value: "safe", label: "安全" },
        ]}
        placeholder="选择一个选项"
      />,
    );

    expect(markup).toContain("响应最快");
    expect(markup).toContain("快速");
    expect(markup).toContain("安全");
  });

  it("forwards the trigger id and aria attributes to the trigger element", () => {
    const markup = renderToStaticMarkup(
      <Select
        id="plugin-configuration-mode"
        value=""
        onValueChange={() => {}}
        options={[{ value: "fast", label: "快速" }]}
        placeholder="选择一个选项"
        aria-labelledby="plugin-configuration-mode-label"
        aria-describedby="plugin-configuration-mode-error"
        aria-invalid={true}
      />,
    );

    expect(markup).toContain('id="plugin-configuration-mode"');
    expect(markup).toContain('aria-labelledby="plugin-configuration-mode-label"');
    expect(markup).toContain('aria-describedby="plugin-configuration-mode-error"');
    expect(markup).toContain('aria-invalid="true"');
  });
});
