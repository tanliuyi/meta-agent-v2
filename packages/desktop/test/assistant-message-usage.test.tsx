import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const viewState = vi.hoisted(() => ({
  pi: null as unknown,
  isOptimistic: false,
  statusType: "complete" as string,
  parts: [{ type: "text", text: "最终回复" }] as ReadonlyArray<{ type: string; text: string }>,
}));

vi.mock("@assistant-ui/react", () => ({
  groupPartByType: () => () => [],
  ActionBarPrimitive: {
    Root: ({ children, autohide, className }: { children: ReactNode; autohide?: string; className?: string }) => (
      <div data-testid="action-bar-root" data-autohide={autohide} className={className}>
        {children}
      </div>
    ),
    Copy: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Reload: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  },
  AuiIf: ({ children }: { children: ReactNode }) => <>{children}</>,
  useAuiState: (selector: (state: unknown) => unknown) =>
    selector({
      message: {
        createdAt: new Date(2026, 0, 2, 9, 5),
        metadata: { custom: { pi: viewState.pi }, isOptimistic: viewState.isOptimistic },
        status: { type: viewState.statusType },
        parts: viewState.parts,
        isCopied: false,
        isLast: true,
      },
    }),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => () => undefined,
}));

vi.mock("../src/renderer/src/state/desktop-context.tsx", () => ({
  useDesktopActions: () => ({ refreshProjectThreads: async () => undefined }),
}));

vi.mock("../src/renderer/src/components/session-context.tsx", () => ({
  useSessionScope: () => ({
    record: { identity: { projectId: "project-1" } },
    active: true,
    commandsReady: true,
    branch: async () => ({ branchThreadId: "thread-2" }),
  }),
}));

vi.mock("../src/renderer/src/components/assistant-ui/tooltip-icon-button.tsx", () => ({
  TooltipIconButton: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { AssistantMessageActionBar } from "../src/renderer/src/components/chat/message/assistant-message-action-bar.tsx";
import {
  formatCost,
  formatMessageTime,
  formatPiUsageSummary,
  formatTokenCount,
} from "../src/renderer/src/components/chat/message/usage-format.ts";

const assistantPi = (usage: unknown) => ({
  kind: "assistant",
  sourceEntryId: "entry-1",
  usage,
});

describe("formatTokenCount", () => {
  it("按 1k / 1M 阈值紧凑格式化并去尾 .0", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1000)).toBe("1k");
    expect(formatTokenCount(12_300)).toBe("12.3k");
    expect(formatTokenCount(100_000)).toBe("100k");
    expect(formatTokenCount(1_000_000)).toBe("1M");
    expect(formatTokenCount(1_234_567)).toBe("1.2M");
  });

  it("舍入进位到 1000k 时提升为 1M", () => {
    expect(formatTokenCount(999_949)).toBe("999.9k");
    expect(formatTokenCount(999_950)).toBe("1M");
    expect(formatTokenCount(999_999)).toBe("1M");
  });
});

describe("formatCost", () => {
  it(">= $1 两位小数，<$1 四位小数并去尾零", () => {
    expect(formatCost(12)).toBe("$12.00");
    expect(formatCost(1.234)).toBe("$1.23");
    expect(formatCost(0.1234)).toBe("$0.1234");
    expect(formatCost(0.1)).toBe("$0.1");
    expect(formatCost(0.1234)).toBe("$0.1234");
  });

  it("极小正费用显示为 <$0.0001", () => {
    expect(formatCost(0.00004)).toBe("<$0.0001");
    expect(formatCost(0.0001)).toBe("$0.0001");
  });
});

describe("formatMessageTime", () => {
  it("按本地时间格式化 HH:mm", () => {
    expect(formatMessageTime(new Date(2026, 0, 2, 9, 5).getTime())).toBe("09:05");
    expect(formatMessageTime(new Date(2026, 0, 2, 0, 5).getTime())).toBe("00:05");
    expect(formatMessageTime(new Date(2026, 0, 2, 23, 59).getTime())).toBe("23:59");
  });

  it("无效 timestamp 返回 null", () => {
    expect(formatMessageTime(NaN)).toBeNull();
    expect(formatMessageTime(Infinity)).toBeNull();
    expect(formatMessageTime(-Infinity)).toBeNull();
    expect(formatMessageTime(1e16)).toBeNull();
  });
});

describe("formatPiUsageSummary", () => {
  it("五个 token 字段为有限非负数时展示总 token 与四项构成，包括 0", () => {
    expect(formatPiUsageSummary({ totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe(
      "0 tokens（输入 0 / 输出 0 / 缓存读 0 / 缓存写 0）",
    );
    expect(
      formatPiUsageSummary({ totalTokens: 12_345, input: 2000, output: 345, cacheRead: 10_000, cacheWrite: 0 }),
    ).toBe("12.3k tokens（输入 2k / 输出 345 / 缓存读 10k / 缓存写 0）");
  });

  it("缓存读写为正时展示对应数值", () => {
    expect(
      formatPiUsageSummary({ totalTokens: 20_000, input: 5000, output: 1000, cacheRead: 12_000, cacheWrite: 2000 }),
    ).toBe("20k tokens（输入 5k / 输出 1k / 缓存读 12k / 缓存写 2k）");
  });

  it("cost.total 为有限正数时拼接费用", () => {
    expect(
      formatPiUsageSummary({
        totalTokens: 12_345,
        input: 2000,
        output: 345,
        cacheRead: 10_000,
        cacheWrite: 0,
        cost: { total: 0.1234 },
      }),
    ).toBe("12.3k tokens（输入 2k / 输出 345 / 缓存读 10k / 缓存写 0） · $0.1234");
    expect(
      formatPiUsageSummary({
        totalTokens: 12_345,
        input: 2000,
        output: 345,
        cacheRead: 10_000,
        cacheWrite: 0,
        cost: { total: 2.5 },
      }),
    ).toBe("12.3k tokens（输入 2k / 输出 345 / 缓存读 10k / 缓存写 0） · $2.50");
    expect(
      formatPiUsageSummary({
        totalTokens: 12_345,
        input: 2000,
        output: 345,
        cacheRead: 10_000,
        cacheWrite: 0,
        cost: { total: 0.00004 },
      }),
    ).toBe("12.3k tokens（输入 2k / 输出 345 / 缓存读 10k / 缓存写 0） · <$0.0001");
  });

  it("cost 缺失、非对象或非有限正数时不展示费用", () => {
    expect(
      formatPiUsageSummary({ totalTokens: 12_345, input: 2000, output: 345, cacheRead: 10_000, cacheWrite: 0 }),
    ).toBe("12.3k tokens（输入 2k / 输出 345 / 缓存读 10k / 缓存写 0）");
    expect(
      formatPiUsageSummary({
        totalTokens: 12_345,
        input: 2000,
        output: 345,
        cacheRead: 10_000,
        cacheWrite: 0,
        cost: "junk",
      }),
    ).toBe("12.3k tokens（输入 2k / 输出 345 / 缓存读 10k / 缓存写 0）");
    expect(
      formatPiUsageSummary({
        totalTokens: 12_345,
        input: 2000,
        output: 345,
        cacheRead: 10_000,
        cacheWrite: 0,
        cost: { total: NaN },
      }),
    ).toBe("12.3k tokens（输入 2k / 输出 345 / 缓存读 10k / 缓存写 0）");
    expect(
      formatPiUsageSummary({
        totalTokens: 12_345,
        input: 2000,
        output: 345,
        cacheRead: 10_000,
        cacheWrite: 0,
        cost: { total: Infinity },
      }),
    ).toBe("12.3k tokens（输入 2k / 输出 345 / 缓存读 10k / 缓存写 0）");
    expect(
      formatPiUsageSummary({
        totalTokens: 12_345,
        input: 2000,
        output: 345,
        cacheRead: 10_000,
        cacheWrite: 0,
        cost: { total: -1 },
      }),
    ).toBe("12.3k tokens（输入 2k / 输出 345 / 缓存读 10k / 缓存写 0）");
  });

  it("五个 token 字段各自畸形（缺失/非数/NaN/Infinity/负数）时返回 null", () => {
    const base = { totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const field of ["totalTokens", "input", "output", "cacheRead", "cacheWrite"] as const) {
      const missing: Record<string, unknown> = { ...base };
      delete missing[field];
      expect(formatPiUsageSummary(missing), `${field} 缺失时应返回 null`).toBeNull();
      for (const bad of ["123", NaN, Infinity, -1]) {
        expect(formatPiUsageSummary({ ...base, [field]: bad }), `${field} 为 ${String(bad)} 时应返回 null`).toBeNull();
      }
    }
  });

  it("畸形 usage 返回 null", () => {
    expect(formatPiUsageSummary(null)).toBeNull();
    expect(formatPiUsageSummary("junk")).toBeNull();
    expect(formatPiUsageSummary([])).toBeNull();
    expect(formatPiUsageSummary(undefined)).toBeNull();
    expect(formatPiUsageSummary({})).toBeNull();
    expect(formatPiUsageSummary({ totalTokens: "123" })).toBeNull();
  });
});

const normalUsage = {
  totalTokens: 12_345,
  input: 2000,
  output: 345,
  cacheRead: 10_000,
  cacheWrite: 0,
  cost: { total: 0.1234 },
};

describe("AssistantMessageActionBar 元数据", () => {
  beforeEach(() => {
    viewState.pi = null;
    viewState.isOptimistic = false;
    viewState.statusType = "complete";
    viewState.parts = [{ type: "text", text: "最终回复" }];
  });

  it("visible 且 usage 正常时按 创建时间 · token构成 · 费用 顺序渲染，并透传 autohide", () => {
    viewState.pi = assistantPi(normalUsage);

    const markup = renderToStaticMarkup(<AssistantMessageActionBar autohide="not-last" />);

    expect(markup).toContain('data-testid="action-bar-root"');
    expect(markup).toContain('data-autohide="not-last"');
    expect(markup).toContain('class="animate-in fade-in flex items-center gap-1 text-muted-foreground duration-200"');
    expect(markup).toContain('data-slot="assistant-message-metadata"');
    expect(markup).toContain("09:05 · 12.3k tokens（输入 2k / 输出 345 / 缓存读 10k / 缓存写 0） · $0.1234");
    expect(markup.indexOf("09:05")).toBeLessThan(markup.indexOf("12.3k tokens"));
    expect(markup.indexOf("12.3k tokens")).toBeLessThan(
      markup.indexOf("（输入 2k / 输出 345 / 缓存读 10k / 缓存写 0）"),
    );
    expect(markup.indexOf("（输入 2k / 输出 345 / 缓存读 10k / 缓存写 0）")).toBeLessThan(markup.indexOf("$0.1234"));
    expect(markup.indexOf('data-testid="action-bar-root"')).toBeLessThan(
      markup.indexOf('data-slot="assistant-message-metadata"'),
    );
  });

  it("元数据在窄消息区域可收缩换行：span 带 min-w-0 且不使用 whitespace-nowrap", () => {
    viewState.pi = assistantPi(normalUsage);

    const markup = renderToStaticMarkup(<AssistantMessageActionBar autohide="not-last" />);
    const span = markup.match(/<span data-slot="assistant-message-metadata" class="([^"]+)"/);
    expect(span).not.toBeNull();
    expect(span![1]).toContain("min-w-0");
    expect(span![1]).not.toContain("whitespace-nowrap");
  });

  it("费用为 0 时展示 创建时间 · token构成", () => {
    viewState.pi = assistantPi({ ...normalUsage, cost: { total: 0 } });

    const markup = renderToStaticMarkup(<AssistantMessageActionBar autohide="not-last" />);

    expect(markup).toContain("09:05 · 12.3k tokens（输入 2k / 输出 345 / 缓存读 10k / 缓存写 0）");
    expect(markup).not.toContain("$");
  });

  it("usage 缺失时仍展示创建时间", () => {
    viewState.pi = { kind: "assistant", sourceEntryId: "entry-1" };

    const markup = renderToStaticMarkup(<AssistantMessageActionBar autohide="not-last" />);

    expect(markup).toContain('data-testid="action-bar-root"');
    expect(markup).toContain('data-slot="assistant-message-metadata"');
    expect(markup).toContain("09:05");
    expect(markup).not.toContain("tokens");
  });

  it("畸形 usage 时仍展示创建时间", () => {
    viewState.pi = assistantPi({ totalTokens: "junk" });

    const markup = renderToStaticMarkup(<AssistantMessageActionBar autohide="not-last" />);

    expect(markup).toContain('data-testid="action-bar-root"');
    expect(markup).toContain('data-slot="assistant-message-metadata"');
    expect(markup).toContain("09:05");
    expect(markup).not.toContain("tokens");
  });

  it("非 assistant 消息（动作栏不可见）时不渲染动作栏与元数据", () => {
    viewState.pi = { kind: "user", sourceEntryId: "entry-1" };

    const markup = renderToStaticMarkup(<AssistantMessageActionBar autohide="not-last" />);

    expect(markup).not.toContain('data-testid="action-bar-root"');
    expect(markup).not.toContain('data-slot="assistant-message-metadata"');
    expect(markup).not.toContain("09:05");
    expect(markup).not.toContain("tokens");
  });

  it("optimistic 消息（动作栏不可见）时不渲染元数据", () => {
    viewState.pi = assistantPi(normalUsage);
    viewState.isOptimistic = true;

    const markup = renderToStaticMarkup(<AssistantMessageActionBar autohide="not-last" />);

    expect(markup).not.toContain('data-slot="assistant-message-metadata"');
    expect(markup).not.toContain("09:05");
    expect(markup).not.toContain("tokens");
  });

  it("running 消息（动作栏不可见）时不渲染元数据", () => {
    viewState.pi = assistantPi(normalUsage);
    viewState.statusType = "running";

    const markup = renderToStaticMarkup(<AssistantMessageActionBar autohide="not-last" />);

    expect(markup).not.toContain('data-slot="assistant-message-metadata"');
    expect(markup).not.toContain("09:05");
    expect(markup).not.toContain("tokens");
  });

  it("无最终回复文本（动作栏不可见）时不渲染元数据", () => {
    viewState.pi = assistantPi(normalUsage);
    viewState.parts = [{ type: "tool-call", toolName: "x" }];

    const markup = renderToStaticMarkup(<AssistantMessageActionBar autohide="not-last" />);

    expect(markup).not.toContain('data-slot="assistant-message-metadata"');
    expect(markup).not.toContain("09:05");
    expect(markup).not.toContain("tokens");
  });
});
