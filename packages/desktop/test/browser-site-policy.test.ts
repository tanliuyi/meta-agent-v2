/**
 * 站点访问策略纯函数与控制器测试（spec §10.5）。
 */

import { describe, expect, test, vi } from "vitest";
import { SiteAccessController } from "../src/main/pi/extensions/pi-browser/lib/site-access.ts";
import {
  checkSiteAccess,
  isLocalSiteUrl,
  isSitePatternValid,
  normalizeSitePattern,
  parseSiteListInput,
  siteMatches,
} from "../src/shared/browser-site-policy.ts";

describe("normalizeSitePattern / isSitePatternValid", () => {
  test("去协议、空白与尾部斜杠，小写", () => {
    expect(normalizeSitePattern("  HTTPS://Example.com/ ")).toBe("example.com");
    expect(normalizeSitePattern("localhost:5173")).toBe("localhost:5173");
    expect(normalizeSitePattern("http://example.com/path")).toBe("example.com");
  });

  test("非法输入返回 null", () => {
    expect(normalizeSitePattern("")).toBeNull();
    expect(normalizeSitePattern("   ")).toBeNull();
    expect(normalizeSitePattern("not a url://")).toBeNull();
  });

  test("端口必须是数字", () => {
    expect(isSitePatternValid("example.com:8080")).toBe(true);
    expect(isSitePatternValid("example.com:http")).toBe(false);
    expect(isSitePatternValid(":8080")).toBe(false);
  });
});

describe("isLocalSiteUrl", () => {
  test("识别 localhost 与 loopback 地址", () => {
    expect(isLocalSiteUrl("http://localhost:3000/app")).toBe(true);
    expect(isLocalSiteUrl("http://127.0.0.1:3000/app")).toBe(true);
    expect(isLocalSiteUrl("http://[::1]:3000/app")).toBe(true);
    expect(isLocalSiteUrl("https://example.com/")).toBe(false);
  });
});

describe("siteMatches", () => {
  test("host 精确匹配与子域匹配", () => {
    expect(siteMatches("example.com", "https://example.com/")).toBe(true);
    expect(siteMatches("example.com", "https://www.example.com/page")).toBe(true);
    expect(siteMatches("example.com", "https://a.b.example.com/")).toBe(true);
    expect(siteMatches("example.com", "https://notexample.com/")).toBe(false);
    expect(siteMatches("example.com", "https://example.org/")).toBe(false);
  });

  test("带端口 pattern 精确匹配 host（含端口），不做子域展开", () => {
    expect(siteMatches("localhost:5173", "http://localhost:5173/")).toBe(true);
    expect(siteMatches("localhost:5173", "http://localhost:8080/")).toBe(false);
    expect(siteMatches("localhost:5173", "http://app.localhost:5173/")).toBe(false);
  });

  test("大小写与非法 URL 处理", () => {
    expect(siteMatches("Example.COM", "https://example.com/")).toBe(true);
    expect(siteMatches("example.com", "not a url")).toBe(false);
    expect(siteMatches("", "https://example.com/")).toBe(false);
  });
});

describe("checkSiteAccess", () => {
  test("blocked 优先于 allowed", () => {
    const settings = { allowSites: ["example.com"], blockSites: ["sub.example.com"] };
    expect(checkSiteAccess(settings, "https://example.com/")).toBe("allowed");
    expect(checkSiteAccess(settings, "https://sub.example.com/")).toBe("blocked");
  });

  test("未列入为 unlisted", () => {
    expect(checkSiteAccess({ allowSites: [], blockSites: [] }, "https://example.com/")).toBe("unlisted");
    expect(checkSiteAccess({ allowSites: ["a.com"], blockSites: [] }, "https://b.com/")).toBe("unlisted");
  });
});

describe("parseSiteListInput", () => {
  test("多行/逗号分隔、去重、过滤非法", () => {
    expect(parseSiteListInput("example.com\nhttps://example.com, localhost:5173\n\nnot a url")).toEqual([
      "example.com",
      "localhost:5173",
    ]);
    expect(parseSiteListInput("")).toEqual([]);
  });
});

describe("SiteAccessController", () => {
  test("blocked 直接拒绝，不触发确认", async () => {
    const controller = new SiteAccessController();
    const confirm = vi.fn();
    const outcome = await controller.check(
      { allowSites: [], blockSites: ["example.com"] },
      "https://example.com/",
      confirm,
    );
    expect(outcome).toMatchObject({ allowed: false, error: { kind: "blocked" } });
    expect(confirm).not.toHaveBeenCalled();
  });

  test("allowed 放行，不触发确认", async () => {
    const controller = new SiteAccessController();
    const confirm = vi.fn();
    const outcome = await controller.check(
      { allowSites: ["example.com"], blockSites: [] },
      "https://example.com/",
      confirm,
    );
    expect(outcome).toMatchObject({ allowed: true });
    expect(confirm).not.toHaveBeenCalled();
  });

  test("本地站点默认免确认", async () => {
    const controller = new SiteAccessController();
    const confirm = vi.fn();
    const outcome = await controller.check(
      { allowSites: [], blockSites: [], allowLocalhostWithoutConfirmation: true },
      "http://127.0.0.1:3000/",
      confirm,
    );
    expect(outcome).toEqual({ allowed: true });
    expect(confirm).not.toHaveBeenCalled();
  });

  test("关闭本地站点豁免后恢复确认，禁止列表仍优先", async () => {
    const controller = new SiteAccessController();
    const confirm = vi.fn().mockResolvedValue(true);
    const outcome = await controller.check(
      { allowSites: [], blockSites: [], allowLocalhostWithoutConfirmation: false },
      "http://localhost:3000/",
      confirm,
    );
    expect(outcome).toEqual({ allowed: true });
    expect(confirm).toHaveBeenCalledOnce();
    const blocked = await controller.check(
      { allowSites: [], blockSites: ["127.0.0.1"], allowLocalhostWithoutConfirmation: true },
      "http://127.0.0.1:3000/",
      confirm,
    );
    expect(blocked).toMatchObject({ allowed: false, error: { kind: "blocked" } });
  });

  test("unlisted 首次确认通过后会话内记住 host，同 host 不再询问", async () => {
    const controller = new SiteAccessController();
    const confirm = vi.fn().mockResolvedValue(true);
    const first = await controller.check({ allowSites: [], blockSites: [] }, "https://example.com/a", confirm);
    const second = await controller.check({ allowSites: [], blockSites: [] }, "https://example.com/b", confirm);
    expect(first).toMatchObject({ allowed: true });
    expect(second).toMatchObject({ allowed: true });
    expect(confirm).toHaveBeenCalledTimes(1);
    // 其他 host 仍会询问。
    const other = await controller.check({ allowSites: [], blockSites: [] }, "https://other.com/", confirm);
    expect(other).toMatchObject({ allowed: true });
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  test("用户拒绝时返回 denied", async () => {
    const controller = new SiteAccessController();
    const confirm = vi.fn().mockResolvedValue(false);
    const outcome = await controller.check({ allowSites: [], blockSites: [] }, "https://example.com/", confirm);
    expect(outcome).toMatchObject({ allowed: false, error: { kind: "denied" } });
  });

  test("确认通道异常时 fail-closed 拒绝", async () => {
    const controller = new SiteAccessController();
    const confirm = vi.fn().mockRejectedValue(new Error("ui 不可用"));
    const outcome = await controller.check({ allowSites: [], blockSites: [] }, "https://example.com/", confirm);
    expect(outcome).toMatchObject({ allowed: false, error: { kind: "denied" } });
  });

  test("设置不可用时拒绝（fail-closed）", async () => {
    const controller = new SiteAccessController();
    const confirm = vi.fn();
    const outcome = await controller.check(undefined, "https://example.com/", confirm);
    expect(outcome).toMatchObject({ allowed: false, error: { kind: "unavailable" } });
    expect(confirm).not.toHaveBeenCalled();
  });

  test("always-allow 策略不触发确认", async () => {
    const controller = new SiteAccessController();
    const confirm = vi.fn();
    const outcome = await controller.check(
      { allowSites: [], blockSites: [], siteApproval: "always-allow" },
      "https://example.com/",
      confirm,
    );
    expect(outcome).toEqual({ allowed: true });
    expect(confirm).not.toHaveBeenCalled();
  });

  test("always-deny 策略不触发确认", async () => {
    const controller = new SiteAccessController();
    const confirm = vi.fn();
    const outcome = await controller.check(
      { allowSites: [], blockSites: [], siteApproval: "always-deny" },
      "https://example.com/",
      confirm,
    );
    expect(outcome).toMatchObject({ allowed: false, error: { kind: "denied" } });
    expect(confirm).not.toHaveBeenCalled();
  });

  test("浏览器关闭时拒绝站点访问", async () => {
    const controller = new SiteAccessController();
    const confirm = vi.fn();
    const outcome = await controller.check(
      { allowSites: ["example.com"], blockSites: [], enabled: false },
      "https://example.com/",
      confirm,
    );
    expect(outcome).toMatchObject({ allowed: false, error: { kind: "unavailable" } });
    expect(confirm).not.toHaveBeenCalled();
  });

  test("reset 清空已确认 host", async () => {
    const controller = new SiteAccessController();
    const confirm = vi.fn().mockResolvedValue(true);
    await controller.check({ allowSites: [], blockSites: [] }, "https://example.com/", confirm);
    controller.reset();
    await controller.check({ allowSites: [], blockSites: [] }, "https://example.com/", confirm);
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});
