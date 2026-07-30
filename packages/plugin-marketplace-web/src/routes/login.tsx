import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Boxes, CircleAlert, LoaderCircle, LogIn } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useAuthLogin, useAuthRegister } from "@/api-hooks.ts";
import { Alert, AlertDescription } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.tsx";
import { authErrorMessage } from "@/lib/marketplace-ui.ts";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

function LoginPage() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const navigate = useNavigate();
  const loginMutation = useAuthLogin();
  const registerMutation = useAuthRegister();
  const mutation = mode === "login" ? loginMutation : registerMutation;

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    try {
      await mutation.mutateAsync({ username: username.trim(), password });
      navigate({ to: "/" });
    } catch {
      // Mutation state renders the error.
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,1fr)_520px]">
      <section className="hidden border-r bg-sidebar p-10 lg:flex lg:flex-col lg:justify-between">
        <div className="flex items-center gap-3">
          <span className="grid size-9 place-items-center rounded-xl bg-sidebar-primary text-sidebar-primary-foreground">
            <Boxes size={19} />
          </span>
          <div>
            <strong className="block text-sm font-semibold">Meta Agent 插件市场</strong>
            <span className="text-xs text-muted-foreground">Publisher Console</span>
          </div>
        </div>
        <div className="max-w-md">
          <h1 className="text-3xl font-semibold tracking-normal">发布者管理控制台</h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">管理插件资料、版本制品和发布生命周期。</p>
        </div>
        <p className="text-xs text-muted-foreground">Marketplace Protocol v1</p>
      </section>

      <main className="flex min-h-screen items-center justify-center p-5 sm:p-10">
        <Card className="w-full max-w-md">
          <CardHeader>
            <div className="mb-3 flex items-center gap-3 lg:hidden">
              <span className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground">
                <Boxes size={18} />
              </span>
              <span className="text-sm font-semibold">插件市场管理</span>
            </div>
            <CardTitle className="text-xl">{mode === "login" ? "登录控制台" : "创建市场账户"}</CardTitle>
            <CardDescription>
              {mode === "login" ? "使用发布者账号继续。" : "用户名仅支持小写字母、数字和 ._-。"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs value={mode} onValueChange={(value) => setMode(value as "login" | "register")}>
              <TabsList className="mb-5 grid w-full grid-cols-2">
                <TabsTrigger value="login">登录</TabsTrigger>
                <TabsTrigger value="register">注册</TabsTrigger>
              </TabsList>
            </Tabs>
            <form className="grid gap-4" onSubmit={submit}>
              <div className="grid gap-2">
                <Label htmlFor="auth-username">用户名</Label>
                <Input
                  id="auth-username"
                  required
                  minLength={3}
                  maxLength={64}
                  autoComplete="username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="auth-password">密码</Label>
                <Input
                  id="auth-password"
                  required
                  minLength={mode === "register" ? 8 : 1}
                  maxLength={128}
                  type="password"
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
                {mode === "register" ? <p className="text-xs text-muted-foreground">至少 8 个字符</p> : null}
              </div>
              {mutation.error ? (
                <Alert variant="destructive">
                  <CircleAlert />
                  <AlertDescription>{authErrorMessage(mutation.error)}</AlertDescription>
                </Alert>
              ) : null}
              <Button className="mt-1 w-full" type="submit" disabled={mutation.isPending}>
                {mutation.isPending ? <LoaderCircle className="animate-spin" /> : <LogIn />}
                {mode === "login" ? "登录" : "创建账户"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
