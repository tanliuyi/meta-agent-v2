import { describe, expect, test } from "vitest";
import {
  BROWSER_PASSWORD_OFFER_BINDING,
  BROWSER_PASSWORD_WATCHER_SCRIPT,
  buildBrowserContactAutofillScript,
  buildBrowserPasswordAutofillScript,
} from "../src/main/browser/browser-form-scripts.ts";

describe("browser form scripts", () => {
  test("watcher 脚本使用宿主 Runtime binding 且防重复安装", () => {
    expect(BROWSER_PASSWORD_OFFER_BINDING).toBe("__piReportPasswordOffer");
    expect(BROWSER_PASSWORD_WATCHER_SCRIPT).toContain("__piPasswordWatcherInstalled");
    expect(BROWSER_PASSWORD_WATCHER_SCRIPT).toContain(BROWSER_PASSWORD_OFFER_BINDING);
    expect(BROWSER_PASSWORD_WATCHER_SCRIPT).toContain("submit");
    expect(BROWSER_PASSWORD_WATCHER_SCRIPT).not.toContain("console.log");
  });

  test("密码账号选择脚本：按 origin 过滤，动态识别表单且由用户选择后填充", () => {
    const script = buildBrowserPasswordAutofillScript({
      origin: "https://example.com",
      passwords: [
        { id: "p1", origin: "https://example.com", username: "alice", password: "s3cret", createdAt: 1, updatedAt: 3 },
        { id: "p3", origin: "https://example.com", username: "carol", password: "pw3", createdAt: 1, updatedAt: 2 },
        { id: "p2", origin: "https://other.com", username: "bob", password: "pw2", createdAt: 1, updatedAt: 2 },
      ],
    });
    // 候选内嵌（填充必须把明文交给页面上下文；注入经 executeJavaScript，不落 DOM）
    expect(script).toContain('"alice"');
    expect(script).toContain("s3cret");
    // other.com 的凭据在 main 侧按 origin 过滤，不进入脚本
    expect(script).not.toContain("bob");
    expect(script).toContain("location.origin !== data.origin");
    expect(script.indexOf("__piPasswordPickerCleanup")).toBeLessThan(script.indexOf("data.candidates.length === 0"));
    expect(script).toContain('autocomplete === "username"');
    expect(script).toContain('field.type === "email"');
    expect(script).not.toContain('field.type === "tel"');
    expect(script).not.toContain('field.type === "text"');
    expect(script).toContain("document.querySelectorAll('input[type=\"password\"]')");
    expect(script).toContain('host.id = "__pi-password-picker"');
    expect(script).toContain('host.attachShadow({ mode: "closed" })');
    expect(script).toContain('heading.textContent = "使用保存的账号"');
    expect(script).toContain('button.setAttribute("role", "option")');
    expect(script).toContain('document.addEventListener("focusin", onFocus, true)');
    expect(script).toContain('document.addEventListener("input", onInput, true)');
    expect(script).toContain('event.key === "ArrowDown"');
    expect(script).toContain('event.key === "Enter" || event.key === " "');
    expect(script).toContain('event.key !== "ArrowUp"');
    expect(script).toContain('event.key === "Escape"');
    expect(script).toContain("event.composedPath().includes(host)");
    expect(script).toContain("event.target instanceof HTMLInputElement && fieldsFor(event.target)");
    expect(script).toContain("suppressedFocusTarget = target");
    expect(script).toContain("queueMicrotask");
    expect(script).not.toContain("new MutationObserver");
    expect(script).toContain("setValue(activeFields.usernameField, candidate.username)");
    expect(script).toContain("setValue(passwordField, candidate.password)");
    expect(script).toContain("focusWithoutOpening(passwordField)");
    expect(() => new Function(script)).not.toThrow();
    // 不在脚本安装或字段聚焦时直接填充第一个候选。
    expect(script).not.toContain("data.candidates[0].password");
  });

  test("联系信息填充脚本：10 个字段的 autocomplete/name 选择器映射", () => {
    const script = buildBrowserContactAutofillScript({
      id: "c1",
      fullName: "张三",
      email: "zhang@example.com",
      phone: "13800000000",
      company: "ACME",
      addressLine1: "一号路",
      addressLine2: "",
      city: "北京",
      region: "",
      postalCode: "100000",
      country: "中国",
      createdAt: 1,
      updatedAt: 2,
    });
    for (const token of [
      '[autocomplete="name"]',
      '[autocomplete="email"]',
      '[autocomplete="tel"]',
      '[autocomplete="organization"]',
      '[autocomplete="street-address"]',
      '[name*="address-line1" i]',
      '[autocomplete="address-line2"]',
      '[autocomplete="address-level2"]',
      '[autocomplete="address-level1"]',
      '[autocomplete="postal-code"]',
      '[autocomplete="country"]',
      '[name*="phone" i]',
      '[name*="email" i]',
    ]) {
      expect(script).toContain(token);
    }
    // 填充逻辑要求只填空字段
    expect(script).toContain("!element.value");
  });
});
