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
    if (window.__piPasswordPickerCleanup) window.__piPasswordPickerCleanup();
    const data = ${payload};
    if (location.origin !== data.origin || data.candidates.length === 0) return;

    const setValue = (element, value) => {
      if (!element || element.value === value) return;
      const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : Object.getPrototypeOf(element);
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(element, value);
      else element.value = value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const isUsernameField = (field) => {
      if (!(field instanceof HTMLInputElement)) return false;
      const autocomplete = field.autocomplete.toLowerCase();
      return (
        autocomplete === "username" ||
        field.type === "email" ||
        /user|login|email/i.test(field.name || field.id)
      );
    };
    const fieldScope = (target) => {
      if (target.form) return target.form;
      let ancestor = target.parentElement;
      while (ancestor && ancestor !== document.body) {
        if (ancestor.querySelector('input[type="password"]')) return ancestor;
        ancestor = ancestor.parentElement;
      }
      return document.querySelectorAll('input[type="password"]').length === 1 ? document : null;
    };
    const fieldsFor = (target) => {
      if (!(target instanceof HTMLInputElement)) return null;
      const scope = fieldScope(target);
      if (!scope) return null;
      const passwordField =
        target.type === "password" ? target : scope.querySelector('input[type="password"]');
      if (!(passwordField instanceof HTMLInputElement)) return null;
      const inputs = Array.from(scope.querySelectorAll("input"));
      const usernameField =
        (target !== passwordField && isUsernameField(target) ? target : null) ||
        inputs.find((field) => field.autocomplete.toLowerCase() === "username") ||
        inputs.find((field) => field.type === "email") ||
        inputs.find((field) => /user|login|email/i.test(field.name || field.id)) ||
        null;
      if (target !== passwordField && target !== usernameField) return null;
      return { usernameField, passwordField };
    };

    const host = document.createElement("div");
    host.id = "__pi-password-picker";
    host.style.cssText = "all:initial;position:fixed;z-index:2147483647;display:none;";
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = \`
      :host { color-scheme: light dark; }
      .picker { box-sizing:border-box;overflow:hidden;min-width:260px;max-width:min(360px,calc(100vw - 16px));padding:6px 0;border:1px solid light-dark(#dadce0,#5f6368);border-radius:8px;background:light-dark(#fff,#292a2d);box-shadow:0 8px 24px rgba(0,0,0,.22);color:light-dark(#202124,#e8eaed);font:13px/1.35 Arial,sans-serif; }
      .heading { padding:6px 14px 8px;color:light-dark(#5f6368,#bdc1c6);font-size:12px; }
      button { box-sizing:border-box;display:grid;width:100%;grid-template-columns:32px minmax(0,1fr);align-items:center;gap:10px;border:0;padding:9px 14px;background:transparent;color:inherit;text-align:left;font:inherit;cursor:default; }
      button:hover,button:focus-visible { outline:0;background:light-dark(#f1f3f4,#3c4043); }
      .avatar { display:grid;width:28px;height:28px;place-items:center;border-radius:50%;background:light-dark(#e8f0fe,#3c4043);color:light-dark(#185abc,#8ab4f8);font-weight:600;text-transform:uppercase; }
      .account { min-width:0; }
      .username { overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500; }
      .origin { overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:light-dark(#5f6368,#bdc1c6);font-size:11px; }
    \`;
    const picker = document.createElement("div");
    picker.className = "picker";
    picker.setAttribute("role", "listbox");
    picker.setAttribute("aria-label", "选择保存的账号");
    shadow.append(style, picker);
    (document.body || document.documentElement).append(host);

    let activeTarget = null;
    let activeFields = null;
    let suppressedFocusTarget = null;
    const close = () => {
      host.style.display = "none";
      activeTarget = null;
      activeFields = null;
      picker.replaceChildren();
    };
    const position = () => {
      if (!activeTarget || !activeTarget.isConnected || host.style.display === "none") return;
      const rect = activeTarget.getBoundingClientRect();
      const width = Math.min(360, Math.max(260, rect.width));
      host.style.width = \`\${width}px\`;
      host.style.left = \`\${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px\`;
      const pickerHeight = host.getBoundingClientRect().height;
      const top = rect.bottom + 4 + pickerHeight <= innerHeight - 8 ? rect.bottom + 4 : Math.max(8, rect.top - pickerHeight - 4);
      host.style.top = \`\${top}px\`;
    };
    const focusWithoutOpening = (target) => {
      suppressedFocusTarget = target;
      target.focus();
      queueMicrotask(() => {
        if (suppressedFocusTarget === target) suppressedFocusTarget = null;
      });
    };
    const select = (candidate) => {
      if (!activeFields) return;
      const passwordField = activeFields.passwordField;
      if (activeFields.usernameField) setValue(activeFields.usernameField, candidate.username);
      setValue(passwordField, candidate.password);
      close();
      focusWithoutOpening(passwordField);
    };
    const render = () => {
      if (!activeTarget || !activeFields) return;
      const query = activeFields.usernameField?.value.trim().toLocaleLowerCase() || "";
      const matches = query
        ? data.candidates.filter((candidate) => candidate.username.toLocaleLowerCase().includes(query))
        : data.candidates;
      const candidates = matches.length > 0 ? matches : data.candidates;
      const heading = document.createElement("div");
      heading.className = "heading";
      heading.textContent = "使用保存的账号";
      picker.replaceChildren(heading);
      for (const candidate of candidates) {
        const button = document.createElement("button");
        button.type = "button";
        button.setAttribute("role", "option");
        button.setAttribute("aria-label", candidate.username || "未命名账号");
        const avatar = document.createElement("span");
        avatar.className = "avatar";
        avatar.textContent = (candidate.username.trim()[0] || "?").toUpperCase();
        const account = document.createElement("span");
        account.className = "account";
        const username = document.createElement("div");
        username.className = "username";
        username.textContent = candidate.username || "未命名账号";
        const origin = document.createElement("div");
        origin.className = "origin";
        origin.textContent = data.origin;
        account.append(username, origin);
        button.append(avatar, account);
        button.addEventListener("pointerdown", (event) => event.preventDefault());
        button.addEventListener("click", () => select(candidate));
        button.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            select(candidate);
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            const target = activeTarget;
            close();
            if (target) focusWithoutOpening(target);
            return;
          }
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          const buttons = Array.from(picker.querySelectorAll("button"));
          const index = buttons.indexOf(button);
          const offset = event.key === "ArrowDown" ? 1 : -1;
          buttons[(index + offset + buttons.length) % buttons.length]?.focus();
        });
        picker.append(button);
      }
      host.style.display = "block";
      position();
    };
    const open = (target) => {
      const fields = fieldsFor(target);
      if (!fields) {
        close();
        return;
      }
      activeTarget = target;
      activeFields = fields;
      render();
    };
    const onFocus = (event) => {
      if (event.composedPath().includes(host)) return;
      if (event.target === suppressedFocusTarget) {
        suppressedFocusTarget = null;
        return;
      }
      open(event.target);
    };
    const onInput = (event) => {
      if (event.target === activeFields?.usernameField) render();
    };
    const onKeyDown = (event) => {
      if (!(event.target instanceof HTMLInputElement)) return;
      if (event.key === "Escape" && activeTarget) {
        event.preventDefault();
        close();
        return;
      }
      if (event.key === "ArrowDown" && fieldsFor(event.target)) {
        event.preventDefault();
        if (!activeTarget) open(event.target);
        shadow.querySelector("button")?.focus();
      }
    };
    const onPointerDown = (event) => {
      if (event.composedPath().includes(host)) return;
      if (event.target instanceof HTMLInputElement && fieldsFor(event.target)) {
        open(event.target);
        return;
      }
      close();
    };
    const onViewportChange = () => {
      if (activeTarget && !activeTarget.isConnected) close();
      else position();
    };
    document.addEventListener("focusin", onFocus, true);
    document.addEventListener("input", onInput, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    window.__piPasswordPickerCleanup = () => {
      document.removeEventListener("focusin", onFocus, true);
      document.removeEventListener("input", onInput, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
      host.remove();
      delete window.__piPasswordPickerCleanup;
    };
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
