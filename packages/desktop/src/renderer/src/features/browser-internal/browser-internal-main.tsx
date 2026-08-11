import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { BrowserDataMutateResult, BrowserDataSnapshot } from "../../../../shared/browser-data-contracts.ts";
import {
  type BrowserInternalPageId,
  browserInternalUrl,
  parseBrowserInternalPage,
} from "../../../../shared/browser-internal-contracts.ts";
import { BrowserContactsPage } from "../../components/panel/browser/internal/browser-contacts-page.tsx";
import { BrowserDownloadsPage } from "../../components/panel/browser/internal/browser-downloads-page.tsx";
import { BrowserHistoryPage } from "../../components/panel/browser/internal/browser-history-page.tsx";
import {
  BROWSER_INTERNAL_PAGES,
  BrowserInternalPages,
} from "../../components/panel/browser/internal/browser-internal-pages.tsx";
import { BrowserPasswordsPage } from "../../components/panel/browser/internal/browser-passwords-page.tsx";
import { BrowserSiteSettingsPage } from "../../components/panel/browser/internal/browser-site-settings-page.tsx";
import "../../styles.css";

function BrowserInternalApp(): React.JSX.Element {
  const page = parseBrowserInternalPage(window.location.href);
  const [snapshot, setSnapshot] = useState<BrowserDataSnapshot | null>(null);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    if (!page) return;
    document.title = BROWSER_INTERNAL_PAGES.find((item) => item.id === page)?.label ?? "浏览器设置";
    setLoadError("");
    void window.browserInternal
      .dataGet(page === "passwords")
      .then(setSnapshot)
      .catch((error: unknown) => {
        setSnapshot(null);
        setLoadError(error instanceof Error ? error.message : String(error));
      });
  }, [page]);

  const applyMutation = useCallback((result: BrowserDataMutateResult): BrowserDataMutateResult => {
    if (result.ok) setSnapshot(result.snapshot);
    return result;
  }, []);
  const mutate = useCallback(
    async (call: () => Promise<BrowserDataMutateResult>): Promise<BrowserDataMutateResult> =>
      applyMutation(await call()),
    [applyMutation],
  );

  if (!page) {
    return <main className="browser-internal-invalid">此 browser:// 页面不存在。</main>;
  }

  const navigate = (nextPage: BrowserInternalPageId): void => {
    window.location.assign(browserInternalUrl(nextPage));
  };

  return (
    <BrowserInternalPages page={page} onNavigate={navigate}>
      {loadError ? <div className="browser-internal-empty">加载失败：{loadError}</div> : null}
      {!loadError && page === "history" ? (
        <BrowserHistoryPage
          snapshot={snapshot}
          onOpenUrl={window.browserInternal.openUrl}
          onDeleteEntry={(url, timestamp) =>
            void window.browserInternal.historyDelete(url, timestamp).then(applyMutation)
          }
          onClearAll={() => void window.browserInternal.historyClear().then(applyMutation)}
        />
      ) : null}
      {!loadError && page === "downloads" ? (
        <BrowserDownloadsPage
          snapshot={snapshot}
          onReveal={(path) => void window.browserInternal.downloadReveal(path)}
          onOpenFile={(path) => void window.browserInternal.downloadOpen(path)}
          onOpenFolder={() => void window.browserInternal.openDownloads()}
          onClearAll={() => void window.browserInternal.downloadsClear().then(applyMutation)}
        />
      ) : null}
      {!loadError && page === "passwords" ? (
        <BrowserPasswordsPage
          snapshot={snapshot}
          onSave={(input) => mutate(() => window.browserInternal.passwordSave(input))}
          onDelete={(id) => mutate(() => window.browserInternal.passwordDelete(id))}
        />
      ) : null}
      {!loadError && page === "contacts" ? (
        <BrowserContactsPage
          snapshot={snapshot}
          onSave={(input) => mutate(() => window.browserInternal.contactSave(input))}
          onDelete={(id) => mutate(() => window.browserInternal.contactDelete(id))}
        />
      ) : null}
      {!loadError && page === "site-settings" ? (
        <BrowserSiteSettingsPage
          snapshot={snapshot}
          onSave={(input) => mutate(() => window.browserInternal.sitePermissionSave(input))}
          onDelete={(id) => mutate(() => window.browserInternal.sitePermissionDelete(id))}
        />
      ) : null}
    </BrowserInternalPages>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing browser internal renderer root element");

createRoot(rootElement).render(
  <StrictMode>
    <BrowserInternalApp />
  </StrictMode>,
);
