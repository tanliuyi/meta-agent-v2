import { Button } from "@renderer/shared/ui/button";
import { Input } from "@renderer/shared/ui/input";
import { useToast } from "@renderer/shared/ui/use-toast";
import RotateCw from "lucide-react/dist/esm/icons/rotate-cw.mjs";
import Save from "lucide-react/dist/esm/icons/save.mjs";
import TestTube from "lucide-react/dist/esm/icons/test-tube.mjs";
import { useEffect, useState } from "react";
import { useMarketplaceEndpointSettings } from "./use-marketplace-endpoint-settings.ts";

interface MarketplaceEndpointSettingsProps {
  onSaved?(): void;
}

export function MarketplaceEndpointSettings({ onSaved }: MarketplaceEndpointSettingsProps) {
  const controller = useMarketplaceEndpointSettings();
  const toast = useToast();
  const [baseUrl, setBaseUrl] = useState("");
  const [dirty, setDirty] = useState(false);
  const active = controller.snapshot?.endpoint;

  useEffect(() => {
    if (controller.error) toast.notify({ message: controller.error, tone: "error" });
  }, [controller.error, toast]);

  useEffect(() => {
    // 只同步未编辑的输入；快照刷新（保存冲突、后台重载）不覆盖用户正在输入的地址。
    if (!dirty) setBaseUrl(active?.baseUrl ?? "");
  }, [active, dirty]);

  const ready = controller.testResult?.status === "ready" ? controller.testResult : undefined;
  const canSave = !controller.pending && baseUrl.trim().length > 0;

  return (
    <section className="marketplace-endpoint-settings" aria-labelledby="marketplace-endpoint-heading">
      <div className="marketplace-endpoint-heading">
        <div>
          <h3 id="marketplace-endpoint-heading">插件市场</h3>
          <span>{active ? active.marketplaceId : "未配置市场 API"}</span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          disabled={controller.loading || controller.pending}
          aria-label="重新载入市场设置"
          title="重新载入"
          onClick={() => {
            setDirty(false);
            controller.resetTest();
            void controller.reload();
          }}
        >
          <RotateCw />
        </Button>
      </div>

      <div className="marketplace-endpoint-form">
        <label htmlFor="marketplace-api-url">Marketplace API URL</label>
        <Input
          id="marketplace-api-url"
          type="url"
          value={baseUrl}
          disabled={controller.loading || controller.pending}
          placeholder="http://market.internal/"
          spellCheck={false}
          autoCapitalize="none"
          onChange={(event) => {
            setBaseUrl(event.currentTarget.value);
            setDirty(true);
            controller.resetTest();
          }}
        />
        <div className="marketplace-endpoint-actions">
          <Button
            variant="outline"
            disabled={controller.pending || baseUrl.trim().length === 0}
            onClick={() => void controller.test(baseUrl)}
          >
            <TestTube />
            测试连接
          </Button>
          <Button
            disabled={!canSave}
            onClick={() =>
              void controller.save(baseUrl).then((result) => {
                if (result?.status === "saved") {
                  setDirty(false);
                  onSaved?.();
                }
              })
            }
          >
            <Save />
            保存
          </Button>
        </div>
      </div>

      {ready ? (
        <div className="marketplace-endpoint-result" data-tone="info" role="status">
          <strong>{ready.endpoint.marketplaceId}</strong>
          <span>{ready.endpoint.apiRoot}</span>
        </div>
      ) : null}
    </section>
  );
}
