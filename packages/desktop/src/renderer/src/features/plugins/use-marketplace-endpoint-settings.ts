import { useCallback, useEffect, useRef, useState } from "react";
import type {
  MarketplaceEndpointSettingsSnapshot,
  SaveMarketplaceEndpointResult,
  TestMarketplaceEndpointResult,
} from "../../../../shared/plugin-marketplace-contracts.ts";

export interface MarketplaceEndpointSettingsController {
  snapshot?: MarketplaceEndpointSettingsSnapshot;
  loading: boolean;
  pending: boolean;
  error?: string;
  testResult?: TestMarketplaceEndpointResult;
  reload(): Promise<void>;
  resetTest(): void;
  test(baseUrl: string): Promise<void>;
  save(baseUrl: string): Promise<SaveMarketplaceEndpointResult | undefined>;
}

export function useMarketplaceEndpointSettings(): MarketplaceEndpointSettingsController {
  const [snapshot, setSnapshot] = useState<MarketplaceEndpointSettingsSnapshot>();
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [testResult, setTestResult] = useState<TestMarketplaceEndpointResult>();
  const mounted = useRef(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const next = await window.desktop.marketplace.getEndpointSettings();
      if (mounted.current) setSnapshot(next);
    } catch (reason) {
      if (mounted.current) setError(errorMessage(reason));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => {
      mounted.current = false;
    };
  }, [reload]);

  const resetTest = useCallback(() => {
    setTestResult(undefined);
    setError(undefined);
  }, []);

  const test = useCallback(
    async (baseUrl: string) => {
      if (pending) return;
      setPending(true);
      setError(undefined);
      try {
        const result = await window.desktop.marketplace.testEndpoint({ baseUrl });
        if (!mounted.current) return;
        setTestResult(result);
        if (result.status === "invalid") setError(marketplaceEndpointErrorMessage(result.message));
      } catch (reason) {
        if (mounted.current) setError(errorMessage(reason));
      } finally {
        if (mounted.current) setPending(false);
      }
    },
    [pending],
  );

  const save = useCallback(
    async (baseUrl: string) => {
      if (!snapshot || pending) return undefined;
      setPending(true);
      setError(undefined);
      try {
        const result = await window.desktop.marketplace.saveEndpoint({
          requestId: crypto.randomUUID(),
          expectedRevision: snapshot.revision,
          baseUrl,
        });
        if (!mounted.current) return result;
        if (result.status === "conflict") {
          setSnapshot(result.current);
          setError("市场设置已在其他窗口中更新，请重新操作。");
        } else {
          setSnapshot(result.snapshot);
          setTestResult(undefined);
        }
        return result;
      } catch (reason) {
        if (mounted.current) setError(errorMessage(reason));
        return undefined;
      } finally {
        if (mounted.current) setPending(false);
      }
    },
    [pending, snapshot],
  );

  return { snapshot, loading, pending, error, testResult, reload, resetTest, test, save };
}

export function marketplaceEndpointErrorMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (message.includes("HTTP 404")) {
    return "该地址不是有效的插件市场 API。请填写市场服务根地址，而不是应用界面地址。";
  }
  return message.replace(/^Error invoking remote method '[^']+': Error:\s*/, "");
}

function errorMessage(reason: unknown): string {
  return marketplaceEndpointErrorMessage(reason);
}
