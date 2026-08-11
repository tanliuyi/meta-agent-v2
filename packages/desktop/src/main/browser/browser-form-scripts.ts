/**
 * 注入 guest 页面的表单脚本：登录表单提交检测（触发密码保存请求）与
 * 已保存凭据的自动填充。脚本在 guest 页面上下文执行（main 侧
 * executeJavaScript 注入），不支持外部依赖。
 */

import type { ContactProfile, SavedPassword } from "../../shared/browser-data-contracts.ts";

/** Runtime binding 名称（由 host controller 消费，不进入 Agent 可读的 console/CDP 缓冲）。 */
export const BROWSER_PASSWORD_OFFER_BINDING = "__piReportPasswordOffer";

/**
 * 表单提交检测脚本：submit 事件捕获登录表单（含 Enter 兜底），
 * 提取用户名/密码后经 main 注册的 Runtime binding 上报。
 */
export const BROWSER_PASSWORD_WATCHER_SCRIPT = `(() => {
  try {
    if (window.__piPasswordWatcherInstalled) return;
    window.__piPasswordWatcherInstalled = true;
    const extract = (form) => {
      const fields = Array.from(form.querySelectorAll("input"));
      const passwordField = fields.find((field) => field.type === "password");
      if (!passwordField || !passwordField.value) return null;
      const usernameField = fields.find(
        (field) =>
          (field.type === "text" || field.type === "email" || field.type === "tel") &&
          field.value.length > 0,
      );
      return {
        url: location.href,
        username: usernameField ? usernameField.value : "",
        password: passwordField.value,
      };
    };
    const report = (data) => {
      if (!data || !data.password) return;
      const binding = globalThis.__piReportPasswordOffer;
      if (typeof binding === "function") binding(JSON.stringify(data));
    };
    document.addEventListener(
      "submit",
      (event) => {
        const form = event.target;
        if (!(form instanceof HTMLFormElement)) return;
        report(extract(form));
      },
      true,
    );
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Enter") return;
        const target = event.target;
        if (!(target instanceof HTMLInputElement)) return;
        const form = target.form;
        if (!form) return;
        // Enter 触发默认提交时由 submit 事件上报；此处兜底无默认提交的表单。
        setTimeout(() => report(extract(form)), 800);
      },
      true,
    );
  } catch {}
})();
`;

/**
 * 自动填充脚本构建：注入已保存凭据（origin 匹配）。密码填入第一个
 * password 字段，用户名优先 autocomplete=username 字段。
 */
export function buildBrowserPasswordAutofillScript(input: { origin: string; passwords: SavedPassword[] }): string {
  const candidates = input.passwords
    .filter((entry) => entry.origin === input.origin)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const payload = JSON.stringify({
    origin: input.origin,
    candidates: candidates.map((entry) => ({ username: entry.username, password: entry.password })),
  });
  return `(() => {
  try {
    const data = ${payload};
    if (location.origin !== data.origin || data.candidates.length === 0) return;
    const setValue = (element, value) => {
      if (!element || element.value === value) return;
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
      if (setter) setter.call(element, value);
      else element.value = value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    };
    let observer;
    const fill = () => {
      const passwordField = document.querySelector('input[type="password"]');
      if (!passwordField) return false;
      const usernameField =
        document.querySelector('input[autocomplete="username"]') ||
        document.querySelector('input[name*="user" i]') ||
        document.querySelector('input[type="email"]') ||
        document.querySelector('input[type="text"]');
      const enteredUsername = usernameField?.value?.trim();
      const candidate =
        (enteredUsername && data.candidates.find((entry) => entry.username === enteredUsername)) || data.candidates[0];
      if (usernameField && !usernameField.value) setValue(usernameField, candidate.username);
      if (!passwordField.value) setValue(passwordField, candidate.password);
      if (passwordField.value) observer?.disconnect();
      return Boolean(passwordField.value);
    };
    if (!fill()) {
      observer = new MutationObserver(fill);
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
    document.addEventListener("focusin", fill, true);
  } catch {}
})();`;
}

/**
 * 联系信息填充脚本构建：按 autocomplete/name 属性将联系人字段映射到表单。
 * 只填充空字段；成功填充任意字段后上报 main（供 UI 提示，预留）。
 */
export function buildBrowserContactAutofillScript(contact: ContactProfile): string {
  const payload = JSON.stringify({
    fullName: contact.fullName,
    email: contact.email,
    phone: contact.phone,
    company: contact.company,
    addressLine1: contact.addressLine1,
    addressLine2: contact.addressLine2,
    city: contact.city,
    region: contact.region,
    postalCode: contact.postalCode,
    country: contact.country,
  });
  return `(() => {
  try {
    const data = ${payload};
    const rules = [
      ["fullName", ['[autocomplete="name"]', '[name*="fullname" i]', '[name*="fname" i]', '[name*="lname" i]', '[name*="name" i]']],
      ["email", ['[autocomplete="email"]', 'input[type="email"]', '[name*="email" i]']],
      ["phone", ['[autocomplete="tel"]', 'input[type="tel"]', '[name*="phone" i]', '[name*="tel" i]']],
      ["company", ['[autocomplete="organization"]', '[name*="company" i]', '[name*="organization" i]']],
      ["addressLine1", ['[autocomplete="street-address"]', '[name*="street" i]', '[name*="address1" i]', '[name*="address-line1" i]']],
      ["addressLine2", ['[autocomplete="address-line2"]', '[name*="address2" i]', '[name*="address-line2" i]']],
      ["city", ['[autocomplete="address-level2"]', '[name*="city" i]']],
      ["region", ['[autocomplete="address-level1"]', '[name*="region" i]', '[name*="state" i]', '[name*="province" i]']],
      ["postalCode", ['[autocomplete="postal-code"]', '[name*="zip" i]', '[name*="postal" i]']],
      ["country", ['[autocomplete="country"]', '[name*="country" i]']],
    ];
    const setValue = (element, value) => {
      if (!element || element.value === value) return;
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
      if (setter) setter.call(element, value);
      else element.value = value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    };
    for (const [key, selectors] of rules) {
      const value = data[key];
      if (!value) continue;
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element && !element.value) {
          setValue(element, value);
          break;
        }
      }
    }
  } catch {}
})();`;
}
