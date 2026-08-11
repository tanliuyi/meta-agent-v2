import { describe, expect, test } from "vitest";
import {
  browserNetworkErrorContent,
  failedAddressDisplay,
} from "../src/renderer/src/components/panel/browser/browser-network-error-page.tsx";

describe("browserNetworkErrorContent", () => {
  test("失败页地址栏按 Chrome 隐藏协议和根路径", () => {
    expect(failedAddressDisplay("http://192.168.10.36:8003/")).toBe("192.168.10.36:8003");
    expect(failedAddressDisplay("https://example.com/login?q=1#form")).toBe("example.com/login?q=1#form");
  });

  test("使用 Chromium 标准错误名生成连接拒绝文案", () => {
    expect(
      browserNetworkErrorContent({
        code: -102,
        description: "ERR_CONNECTION_REFUSED",
        url: "http://192.168.10.36:8003/console/mentor",
      }),
    ).toEqual({
      heading: "无法访问此网站",
      summary: "192.168.10.36:8003 拒绝了我们的连接请求。",
      suggestions: ["检查网络连接", "检查代理服务器和防火墙"],
    });
  });

  test("区分离线、域名解析和证书错误", () => {
    expect(
      browserNetworkErrorContent({
        code: -106,
        description: "ERR_INTERNET_DISCONNECTED",
        url: "https://example.com/",
      }).heading,
    ).toBe("未连接到互联网");
    expect(
      browserNetworkErrorContent({
        code: -105,
        description: "ERR_NAME_NOT_RESOLVED",
        url: "https://example.com/",
      }).summary,
    ).toBe("example.com 的服务器 IP 地址找不到。");
    expect(
      browserNetworkErrorContent({
        code: -202,
        description: "ERR_CERT_AUTHORITY_INVALID",
        url: "https://example.com/",
      }).heading,
    ).toBe("您的连接不是私密连接");
  });

  test("未知 Chromium 错误使用通用页面文案", () => {
    expect(
      browserNetworkErrorContent({
        code: -324,
        description: "ERR_EMPTY_RESPONSE",
        url: "https://example.com/path",
      }),
    ).toEqual({
      heading: "无法访问此网站",
      summary: "example.com 暂时无法处理此请求。",
      suggestions: ["检查网络连接", "稍后重新加载此页面"],
    });
  });
});
