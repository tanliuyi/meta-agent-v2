import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { BrowserCrypto } from "../src/main/browser/browser-data-service.ts";
import { BrowserDataService } from "../src/main/browser/browser-data-service.ts";

const directories: string[] = [];

/** 测试用“加密”：base64 反转 + 前缀，可逆且不依赖系统安全存储。 */
function testCrypto(): BrowserCrypto {
  return {
    isAvailable: () => true,
    encrypt: (value) => Buffer.from(value, "utf8").reverse().toString("base64"),
    decrypt: (value) => Buffer.from(value, "base64").reverse().toString("utf8"),
  };
}

describe("BrowserDataService", () => {
  let userDataDir: string;
  let service: BrowserDataService;

  beforeEach(() => {
    userDataDir = join(tmpdir(), `desktop-browser-data-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    directories.push(userDataDir);
    service = new BrowserDataService(userDataDir, { crypto: testCrypto() });
  });

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
    vi.useRealTimers();
  });

  test("初始快照为空且不创建文件", async () => {
    const snapshot = await service.getSnapshot();
    expect(snapshot).toMatchObject({
      history: [],
      downloads: [],
      contacts: [],
      passwords: [],
      sitePermissions: [],
    });
    await expect(readFile(join(userDataDir, "browser-data.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("记录历史：忽略空白页，同 URL 连续访问合并更新，隔开访问各留一条", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(500);
    await service.recordHistory("about:blank", "");
    await service.recordHistory("browser://history", "浏览历史");
    expect((await service.getSnapshot()).history).toEqual([]);

    vi.setSystemTime(1_000);
    await service.recordHistory("https://example.com/a", "A");
    vi.setSystemTime(2_000);
    // 首条同 url 且 30 分钟内：合并更新时间戳与标题
    await service.recordHistory("https://example.com/a", "A2");
    expect(await service.getSnapshot()).toMatchObject({
      history: [{ url: "https://example.com/a", title: "A2", timestamp: 2_000 }],
    });

    vi.setSystemTime(3_000);
    await service.recordHistory("https://example.com/b", "B");
    vi.setSystemTime(4_000);
    // 首条是 b：a 重新出现在最前（各自保留）
    await service.recordHistory("https://example.com/a", "A3");
    const snapshot = await service.getSnapshot();
    expect(snapshot.history.map((entry) => entry.url)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/a",
    ]);
    await service.updateLatestHistoryTitle("https://example.com/a", "最终标题");
    expect((await service.getSnapshot()).history[0]).toEqual({
      url: "https://example.com/a",
      title: "最终标题",
      timestamp: 4_000,
    });

    // 删除单条（按 url + timestamp 精确匹配）
    await service.deleteHistoryEntry("https://example.com/a", 2_000);
    expect((await service.getSnapshot()).history).toHaveLength(2);
    await service.clearHistory();
    expect((await service.getSnapshot()).history).toHaveLength(0);
  });

  test("记录下载并清除（不触碰已下载文件）", async () => {
    await service.recordDownload({
      url: "https://example.com/file.zip",
      filename: "file.zip",
      path: "/tmp/file.zip",
      totalBytes: 100,
      receivedBytes: 100,
      state: "completed",
      startedAt: 1_000,
      endedAt: 2_000,
    });
    await service.recordDownload({
      url: "https://example.com/broken.zip",
      filename: "broken.zip",
      path: null,
      totalBytes: 0,
      receivedBytes: 0,
      state: "interrupted",
      startedAt: 3_000,
      endedAt: null,
    });

    const snapshot = await service.getSnapshot();
    expect(snapshot.downloads).toHaveLength(2);
    expect(snapshot.downloads[0]).toMatchObject({ filename: "broken.zip", state: "interrupted", path: null });

    const result = await service.clearDownloads();
    expect(result.ok).toBe(true);
    expect(result.ok && result.snapshot.downloads).toHaveLength(0);
  });

  test("保存/更新/删除密码：同站点账号自动更新，密文落盘，快照返回明文", async () => {
    const created = await service.savePassword({
      passwordId: null,
      password: { origin: "https://example.com", username: "alice", password: "s3cret" },
    });
    expect(created.ok).toBe(true);
    const createdId = created.ok ? created.snapshot.passwords[0].id : "unreachable";

    const snapshot = await service.getSnapshot();
    expect(snapshot.passwords).toHaveLength(1);
    expect(snapshot.passwords[0]).toMatchObject({
      origin: "https://example.com",
      username: "alice",
      password: "s3cret",
    });

    // 密文文件不含明文
    const raw = JSON.parse(await readFile(join(userDataDir, "browser-passwords.json"), "utf8")) as {
      entries: Array<{ cipher: string }>;
    };
    expect(raw.entries[0].cipher).not.toContain("s3cret");

    // 更新
    await service.savePassword({
      passwordId: createdId,
      password: { origin: "https://example.com", username: "alice", password: "n3w" },
    });
    expect((await service.getSnapshot()).passwords[0]).toMatchObject({ password: "n3w", username: "alice" });

    // 未提供 id 时，同站点 + 同账号仍应更新原条目，而不是新建重复密码。
    await service.savePassword({
      passwordId: null,
      password: { origin: "https://example.com", username: "alice", password: "latest" },
    });
    const updatedSnapshot = await service.getSnapshot();
    expect(updatedSnapshot.passwords).toHaveLength(1);
    expect(updatedSnapshot.passwords[0]).toMatchObject({ id: createdId, password: "latest", username: "alice" });

    await service.deletePassword(createdId);
    expect((await service.getSnapshot()).passwords).toHaveLength(0);
  });

  test("系统安全存储不可用时保存密码返回错误", async () => {
    const unavailable = new BrowserDataService(userDataDir, {
      crypto: { isAvailable: () => false, encrypt: () => "", decrypt: () => "" },
    });
    const result = await unavailable.savePassword({
      passwordId: null,
      password: { origin: "https://example.com", username: "u", password: "p" },
    });
    expect(result).toMatchObject({ ok: false });
  });

  test("联系信息：新建、更新、删除", async () => {
    const created = await service.saveContact({
      contactId: null,
      contact: {
        fullName: "张三",
        email: "z@example.com",
        phone: "138",
        company: "",
        addressLine1: "",
        addressLine2: "",
        city: "",
        region: "",
        postalCode: "",
        country: "",
      },
    });
    expect(created.ok).toBe(true);
    const id = created.ok ? created.snapshot.contacts[0].id : "unreachable";

    await service.saveContact({
      contactId: id,
      contact: {
        fullName: "张三丰",
        email: "z@example.com",
        phone: "",
        company: "",
        addressLine1: "",
        addressLine2: "",
        city: "",
        region: "",
        postalCode: "",
        country: "",
      },
    });
    expect((await service.getSnapshot()).contacts[0]).toMatchObject({ fullName: "张三丰" });

    await service.deleteContact(id);
    expect((await service.getSnapshot()).contacts).toHaveLength(0);
  });

  test("网站设置：同站点同权限覆盖，列表按录入顺序返回", async () => {
    await service.saveSitePermission({ site: "https://Example.com", kind: "camera", value: "deny" });
    await service.saveSitePermission({ site: "example.com", kind: "camera", value: "allow" });
    await service.saveSitePermission({ site: "news.example.com", kind: "notifications", value: "deny" });

    const list = await service.listSitePermissions();
    expect(list).toHaveLength(2);
    // 新条目在前（unshift）
    expect(list[0]).toMatchObject({ site: "news.example.com", kind: "notifications", value: "deny" });
    expect(list[1]).toMatchObject({ site: "example.com", kind: "camera", value: "allow" });

    await service.deleteSitePermission(list[0].id);
    expect(await service.listSitePermissions()).toHaveLength(1);
  });

  test("损坏的 JSON 文件不抛错，按空数据继续", async () => {
    await mkdir(userDataDir, { recursive: true });
    await writeFile(join(userDataDir, "browser-data.json"), "{broken", "utf8");

    const snapshot = await service.getSnapshot();
    expect(snapshot.history).toEqual([]);

    // 恢复后可正常写入
    await service.recordHistory("https://example.com", "A", 1);
    expect((await service.getSnapshot()).history).toHaveLength(1);
  });

  test("持久化历史跨实例读取", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    await service.recordHistory("https://example.com", "A");
    const other = new BrowserDataService(userDataDir, { crypto: testCrypto() });
    const snapshot = await other.getSnapshot();
    expect(snapshot.history).toMatchObject([{ url: "https://example.com", title: "A" }]);
  });
});
