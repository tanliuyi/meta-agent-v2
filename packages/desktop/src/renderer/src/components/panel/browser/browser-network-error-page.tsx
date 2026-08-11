import FileWarning from "lucide-react/dist/esm/icons/file-warning.mjs";
import RotateCw from "lucide-react/dist/esm/icons/rotate-cw.mjs";
import type { BrowserLoadError } from "../../../../../shared/browser-contracts.ts";

export interface BrowserNetworkErrorContent {
  heading: string;
  summary: string;
  suggestions: readonly string[];
}

/** Chrome 失败页地址栏隐藏 http(s) 协议与根路径，保留端口和非根路径。 */
export function failedAddressDisplay(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return url;
    const path = parsed.pathname === "/" && !parsed.search && !parsed.hash ? "" : parsed.pathname;
    return `${parsed.host}${path}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}

function displayHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Chrome neterror 页面层级的本地化文案；错误名和错误码直接来自 Chromium。 */
export function browserNetworkErrorContent(error: BrowserLoadError): BrowserNetworkErrorContent {
  const host = displayHost(error.url);
  switch (error.description) {
    case "ERR_INTERNET_DISCONNECTED":
      return {
        heading: "未连接到互联网",
        summary: "请检查您的网络连接。",
        suggestions: ["检查网线、调制解调器和路由器", "重新连接到 Wi-Fi 网络"],
      };
    case "ERR_NAME_NOT_RESOLVED":
      return {
        heading: "无法访问此网站",
        summary: `${host} 的服务器 IP 地址找不到。`,
        suggestions: ["检查网络连接", "检查 DNS 配置"],
      };
    case "ERR_CONNECTION_REFUSED":
      return {
        heading: "无法访问此网站",
        summary: `${host} 拒绝了我们的连接请求。`,
        suggestions: ["检查网络连接", "检查代理服务器和防火墙"],
      };
    case "ERR_TIMED_OUT":
    case "ERR_CONNECTION_TIMED_OUT":
      return {
        heading: "无法访问此网站",
        summary: `${host} 的响应时间过长。`,
        suggestions: ["检查网络连接", "检查代理服务器和防火墙"],
      };
    case "ERR_PROXY_CONNECTION_FAILED":
      return {
        heading: "无法连接到代理服务器",
        summary: "代理服务器出现问题或地址不正确。",
        suggestions: ["检查代理服务器设置", "联系网络管理员"],
      };
    default:
      if (error.description.startsWith("ERR_CERT_")) {
        return {
          heading: "您的连接不是私密连接",
          summary: `${host} 返回的安全证书无效。`,
          suggestions: ["检查设备的日期和时间", "联系网站所有者"],
        };
      }
      return {
        heading: "无法访问此网站",
        summary: `${host} 暂时无法处理此请求。`,
        suggestions: ["检查网络连接", "稍后重新加载此页面"],
      };
  }
}

export function BrowserNetworkErrorPage({ error, onRetry }: { error: BrowserLoadError; onRetry: () => void }) {
  const content = browserNetworkErrorContent(error);

  return (
    <div className="browser-network-error" role="document" aria-labelledby="browser-network-error-heading">
      <div className="browser-network-error-content">
        <FileWarning className="browser-network-error-icon" size={72} strokeWidth={1.25} aria-hidden="true" />
        <h1 id="browser-network-error-heading">{content.heading}</h1>
        <p className="browser-network-error-summary">{content.summary}</p>
        <div className="browser-network-error-suggestions">
          <p>请尝试以下操作：</p>
          <ul>
            {content.suggestions.map((suggestion) => (
              <li key={suggestion}>{suggestion}</li>
            ))}
          </ul>
        </div>
        <p className="browser-network-error-code">{error.description}</p>
        <div className="browser-network-error-actions">
          <button type="button" className="browser-network-error-reload" onClick={onRetry}>
            <RotateCw size={15} aria-hidden="true" />
            重新加载
          </button>
          <details className="browser-network-error-details">
            <summary>详细信息</summary>
            <div>
              <p>网址：{error.url}</p>
              <p>
                错误代码：{error.description} ({error.code})
              </p>
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}
