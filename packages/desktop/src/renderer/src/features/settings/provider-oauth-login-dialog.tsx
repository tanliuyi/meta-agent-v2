import { Select } from "@renderer/components/assistant-ui/select/select";
import { Button } from "@renderer/shared/ui/button";
import { Dialog } from "@renderer/shared/ui/dialog";
import { DialogContent } from "@renderer/shared/ui/dialog-content";
import { DialogDescription } from "@renderer/shared/ui/dialog-description";
import { DialogFooter } from "@renderer/shared/ui/dialog-footer";
import { DialogTitle } from "@renderer/shared/ui/dialog-title";
import { Input } from "@renderer/shared/ui/input";
import Copy from "lucide-react/dist/esm/icons/copy.mjs";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.mjs";
import { useEffect, useMemo, useState } from "react";
import type { AuthOauthLoginEvent } from "../../../../shared/auth-config-contracts.ts";

export interface ProviderOauthLoginState {
  loginId: string;
  providerName: string;
  active: boolean;
  events: AuthOauthLoginEvent[];
  error?: string;
}

interface ProviderOauthLoginDialogProps {
  state: ProviderOauthLoginState;
  onClose(): void;
}

export function ProviderOauthLoginDialog({ state, onClose }: ProviderOauthLoginDialogProps) {
  const auth = useMemo(() => state.events.findLast((event) => event.type === "auth"), [state.events]);
  const deviceCode = useMemo(() => state.events.findLast((event) => event.type === "device-code"), [state.events]);
  const info = useMemo(() => state.events.findLast((event) => event.type === "info"), [state.events]);
  const progress = useMemo(() => state.events.findLast((event) => event.type === "progress"), [state.events]);
  const request = useMemo(() => state.events.findLast((event) => event.type === "request"), [state.events]);
  const [value, setValue] = useState("");
  const [submittedRequestId, setSubmittedRequestId] = useState<string>();
  const activeRequest = request?.type === "request" && request.requestId !== submittedRequestId ? request : undefined;

  useEffect(() => {
    setValue("");
    setSubmittedRequestId(undefined);
  }, [request?.type === "request" ? request.requestId : undefined]);

  const respond = async (canceled = false) => {
    if (!activeRequest) return;
    await window.desktop.auth.respondToOauth({
      loginId: state.loginId,
      requestId: activeRequest.requestId,
      ...(canceled ? { canceled: true } : { value }),
    });
    setSubmittedRequestId(activeRequest.requestId);
  };

  const close = () => {
    if (state.active) void window.desktop.auth.cancelOauth(state.loginId);
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent
        className="sm:max-w-lg"
        closeButtonClassName="hidden"
        onEscapeKeyDown={(event) => event.preventDefault()}
      >
        <DialogTitle>登录 {state.providerName}</DialogTitle>
        <DialogDescription>OAuth 凭据将直接保存到全局 auth.json。</DialogDescription>

        {auth?.type === "auth" ? (
          <div className="grid gap-1 rounded-xl border p-3 text-sm">
            <span>{auth.instructions ?? "请在已打开的浏览器页面中完成授权。"}</span>
            <code className="break-all text-xs text-muted-foreground">{auth.url}</code>
          </div>
        ) : null}

        {deviceCode?.type === "device-code" ? (
          <div className="grid gap-2 rounded-xl border p-3 text-sm">
            <span>在授权页面输入设备码</span>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 rounded bg-muted px-3 py-2 text-center text-base font-semibold">
                {deviceCode.userCode}
              </code>
              <Button
                variant="outline"
                size="icon"
                aria-label="复制设备码"
                onClick={() => void navigator.clipboard.writeText(deviceCode.userCode)}
              >
                <Copy />
              </Button>
            </div>
          </div>
        ) : null}

        {info?.type === "info" ? (
          <div className="grid gap-1 rounded-xl border p-3 text-sm">
            <span>{info.message}</span>
            {info.links?.map((link) => (
              <a
                key={link.url}
                href={link.url}
                className="break-all text-xs text-primary underline underline-offset-2 hover:text-primary/80"
                onClick={(event) => {
                  event.preventDefault();
                  void window.desktop.links.open("", link.url);
                }}
              >
                {link.label ?? link.url}
              </a>
            ))}
          </div>
        ) : null}

        {activeRequest ? (
          <div className="grid gap-2">
            <label className="text-sm font-medium">{activeRequest.message}</label>
            {activeRequest.requestType === "select" ? (
              <Select
                value={value}
                placeholder="请选择"
                options={(activeRequest.options ?? []).map((option) => ({
                  value: option.id,
                  label: option.description ? `${option.label} — ${option.description}` : option.label,
                }))}
                onValueChange={setValue}
              />
            ) : (
              <Input
                autoFocus
                value={value}
                placeholder={activeRequest.placeholder}
                onChange={(event) => setValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (activeRequest.allowEmpty || value)) void respond();
                }}
              />
            )}
          </div>
        ) : null}

        {progress?.type === "progress" ? <p className="text-sm text-muted-foreground">{progress.message}</p> : null}
        {!activeRequest && state.active ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            等待授权完成
          </div>
        ) : null}
        {state.error ? (
          <p className="text-sm text-destructive" role="alert">
            {state.error}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={close}>
            {state.active ? "取消" : "关闭"}
          </Button>
          {activeRequest ? (
            <Button disabled={!activeRequest.allowEmpty && !value} onClick={() => void respond()}>
              继续
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
