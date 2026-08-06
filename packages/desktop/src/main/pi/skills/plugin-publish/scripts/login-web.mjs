#!/usr/bin/env node
// Web login/register: start a loopback HTTP server, open the browser, and let
// the user enter credentials on a page. The page submits to the local server,
// which forwards to the marketplace auth API and writes the session token to
// a 0600 file. Passwords never reach argv, shell history, or the agent.
//
// Usage:
//   node login-web.mjs <apiRoot> <tokenOut> [publisherId] [--register] [--timeout <seconds>]
//
// Modes: login (default) or register (--register). When publisherId is given,
// membership is checked via /auth/me and the token file is removed on failure.
// The server binds 127.0.0.1 on a random port, serves one page, and exits
// after a successful login/registration or the timeout (default 300 s).
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { writeFileSync, chmodSync, rmSync } from "node:fs";
import os from "node:os";

const args = process.argv.slice(2);
let register = false;
let timeoutSec = 300;
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--register") register = true;
  else if (args[i] === "--timeout" && args[i + 1]) timeoutSec = Number(args[++i]) || 300;
  else positional.push(args[i]);
}
const [apiRoot, tokenOut, publisherId] = positional;
if (!apiRoot || !tokenOut) {
  console.error(
    "usage: node login-web.mjs <apiRoot> <tokenOut> [publisherId] [--register] [--timeout <seconds>]",
  );
  process.exitCode = 2;
} else {
  run();
}

function run() {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/`;
    console.log(`Open ${url} in your browser (closing this process in ${timeoutSec}s without a login)`);
    openBrowser(url);
    setTimeout(() => {
      console.error("TIMEOUT: no successful login within", timeoutSec, "seconds");
      server.close();
      process.exitCode = 1;
    }, timeoutSec * 1000);
  });

  const page = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${register ? "注册" : "登录"} — Meta Agent 插件市场</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
    font-family: system-ui,-apple-system,"Segoe UI",sans-serif;
    background:#f6f7f9; color:#1f2328; }
  .card { width:min(92vw,400px); background:#fff; border:1px solid #d8dde4;
    border-radius:12px; padding:28px; box-shadow:0 8px 30px rgba(0,0,0,.06); }
  h1 { font-size:18px; margin:0 0 4px; }
  p.sub { color:#6b7280; font-size:13px; margin:0 0 20px; }
  label { display:block; font-size:13px; font-weight:600; margin:14px 0 6px; }
  input { width:100%; box-sizing:border-box; padding:9px 11px; font-size:14px;
    border:1px solid #c9d1d9; border-radius:8px; background:#fff; color:inherit; }
  input:focus { outline:2px solid #4f8cff; border-color:transparent; }
  button { width:100%; margin-top:22px; padding:10px; font-size:14px; font-weight:600;
    border:0; border-radius:8px; background:#2563eb; color:#fff; cursor:pointer; }
  button:disabled { opacity:.55; cursor:wait; }
  #err { display:none; margin-top:14px; padding:10px 12px; font-size:13px;
    background:#fde8e8; color:#b42318; border:1px solid #f5c2c2; border-radius:8px; }
  #ok { display:none; text-align:center; padding:18px 0 6px; }
  #ok .badge { width:52px; height:52px; margin:0 auto 12px; border-radius:50%;
    background:#dcfce7; color:#15803d; font-size:30px; line-height:52px; }
  #ok b { font-size:15px; }
  #ok p { color:#6b7280; font-size:13px; margin:8px 0 0; }
  .tabs { display:grid; grid-template-columns:1fr 1fr; gap:4px; background:#eef1f5;
    border-radius:8px; padding:4px; margin-bottom:6px; }
  .tabs a { text-align:center; padding:7px; font-size:13px; border-radius:6px;
    color:#4b5563; text-decoration:none; }
  .tabs a.on { background:#fff; color:#111; font-weight:600; box-shadow:0 1px 3px rgba(0,0,0,.1); }
  footer { margin-top:18px; text-align:center; font-size:11px; color:#9ca3af; }
</style>
</head>
<body>
<div class="card">
  <h1>Meta Agent 插件市场</h1>
  <p class="sub">${register ? "创建一个新账号" : "登录你的账号"}，你的信息只用于本次登录。</p>
  <div class="tabs">
    <a href="/?mode=login" class="${register ? "" : "on"}">登录</a>
    <a href="/?mode=register" class="${register ? "on" : ""}">注册</a>
  </div>
  <form id="f">
    <label for="u">用户名</label>
    <input id="u" name="username" autocomplete="username" required
      pattern="[a-z0-9._-]+" title="仅支持小写字母、数字和 ._-">
    <label for="p">密码</label>
    <input id="p" name="password" type="password" autocomplete="current-password" required>
    <div id="p2wrap" style="display:none">
      <label for="p2">确认密码</label>
      <input id="p2" name="password2" type="password" autocomplete="new-password">
    </div>
    <button id="b" type="submit">${register ? "注册" : "登录"}</button>
  </form>
  <div id="err"></div>
  <div id="ok">
    <div class="badge">✓</div>
    <b>${register ? "注册" : "登录"}成功</b>
    <p>登录成功，可以关闭此页面。</p>
  </div>
  <footer>Meta Agent</footer>
</div>
<script>
  const isRegister = ${register};
  const p2wrap = document.getElementById("p2wrap");
  if (isRegister) p2wrap.style.display = "block";
  document.getElementById("f").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const err = document.getElementById("err");
    err.style.display = "none";
    const u = document.getElementById("u").value.trim();
    const p = document.getElementById("p").value;
    const p2 = document.getElementById("p2").value;
    if (isRegister && p !== p2) {
      err.textContent = "两次输入的密码不一致";
      err.style.display = "block";
      return;
    }
    const b = document.getElementById("b");
    b.disabled = true;
    b.textContent = "提交中…";
    try {
      const res = await fetch("/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: u, password: p }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        document.getElementById("f").style.display = "none";
        document.getElementById("ok").style.display = "block";
        if (isRegister) document.querySelector(".tabs").style.display = "none";
      } else {
        err.textContent = data.error || "请求失败（HTTP " + res.status + "）";
        err.style.display = "block";
        b.disabled = false;
        b.textContent = isRegister ? "注册" : "登录";
      }
    } catch (e) {
      err.textContent = "无法连接本地服务：" + e.message;
      err.style.display = "block";
      b.disabled = false;
      b.textContent = isRegister ? "注册" : "登录";
    }
  });
</script>
</body>
</html>`;

  const okPage = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>成功</title></head>
<body style="font-family:system-ui;display:grid;place-items:center;min-height:100vh;background:#f6f7f9">
<div style="text-align:center;background:#fff;border:1px solid #d8dde4;border-radius:12px;padding:32px 40px">
<div style="width:52px;height:52px;margin:0 auto 12px;border-radius:50%;background:#dcfce7;color:#15803d;font-size:30px;line-height:52px">✓</div>
<b style="font-size:15px">${register ? "注册" : "登录"}成功</b>
<p style="color:#6b7280;font-size:13px">登录成功，可以关闭此页面。</p></div></body></html>`;

  function fail(code, msg) {
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>出错了</title></head>
<body style="font-family:system-ui;display:grid;place-items:center;min-height:100vh;background:#f6f7f9">
<div style="text-align:center;background:#fff;border:1px solid #d8dde4;border-radius:12px;padding:32px 40px;max-width:420px">
<b style="font-size:15px;color:#b42318">${code}</b>
<p style="color:#6b7280;font-size:13px">${msg}</p></div></body></html>`;
  }

  async function handler(req, res) {
    const url = new URL(req.url, `http://127.0.0.1`);
    if (url.pathname === "/" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(page);
      return;
    }
    if (url.pathname === "/submit" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      let creds;
      try {
        creds = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "bad request body" }));
        return;
      }
      const username = String(creds.username ?? "").trim();
      const password = String(creds.password ?? "");
      if (!username || !password) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "用户名和密码不能为空" }));
        return;
      }
      try {
        const authRes = await fetch(`${apiRoot}/auth/${register ? "register" : "login"}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        });
        const authData = await authRes.json().catch(() => ({}));
        if (!authRes.ok) {
          const msg =
            authData.error ?? (authRes.status === 429 ? "尝试过于频繁，请稍后再试" : `认证失败（HTTP ${authRes.status}）`);
          res.writeHead(authRes.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: msg }));
          return;
        }
        const token = authData.token;
        if (!token) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "认证响应缺少令牌" }));
          return;
        }
        // Verify publisher membership when requested; drop the token on failure.
        if (publisherId) {
          const meRes = await fetch(`${apiRoot}/auth/me`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          const me = await meRes.json().catch(() => ({}));
          if (!meRes.ok || !me.publisherIds?.includes(publisherId)) {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({ ok: false, error: `账号不是发布者 ${publisherId} 的成员，请先联系市场管理员` }),
            );
            return;
          }
        }
        writeFileSync(tokenOut, token, { mode: 0o600 });
        chmodSync(tokenOut, 0o600);
        console.log(`AUTH_OK token written to ${tokenOut} (user: ${username})`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        // One successful auth is enough; shut the server down shortly after
        // the page has rendered the result.
        setTimeout(() => server.close(), 1500);
      } catch (err) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: `本地转发失败：${err.message}` }));
      }
      return;
    }
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fail("404", "页面不存在"));
  }
}

function openBrowser(url) {
  const platform = os.platform();
  try {
    if (platform === "win32") spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true });
    else if (platform === "darwin") spawn("open", [url], { stdio: "ignore", detached: true });
    else spawn("xdg-open", [url], { stdio: "ignore", detached: true });
  } catch {
    console.error(`Could not open a browser automatically; open ${url} manually`);
  }
}
