import { CircleAlert, LoaderCircle, Plus, Save, ShieldCheck, Trash2, UserCog } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import type { AdminUser, PublisherAdminView, UserRole } from "@/api.ts";
import {
  useAdminPublishers,
  useAdminUsers,
  useCurrentUser,
  useSession,
  useUpdateAdminPublisherMember,
  useUpdateAdminUserRole,
  useUpsertAdminPublisher,
} from "@/api-hooks.ts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.tsx";
import { errorMessage } from "@/lib/marketplace-ui.ts";

export function SystemAdminPage() {
  const session = useSession();
  const token = session.data?.token ?? null;
  const currentUser = useCurrentUser(token);
  const isAdmin = currentUser.data?.admin === true;
  const isSuperAdmin = currentUser.data?.role === "super_admin";
  const publishers = useAdminPublishers(token, isAdmin);
  const users = useAdminUsers(token, isSuperAdmin);

  if (session.isPending || currentUser.isPending) {
    return <div className="h-40 animate-pulse border-y bg-muted/30" />;
  }
  if (!token || !isAdmin) {
    return (
      <Alert variant="destructive">
        <CircleAlert />
        <AlertTitle>无权访问系统管理</AlertTitle>
        <AlertDescription>当前账户没有管理员权限。</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b pb-5">
        <div>
          <p className="text-xs font-medium text-muted-foreground">SYSTEM CONTROL</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-normal">系统管理</h1>
          <p className="mt-2 text-sm text-muted-foreground">账户角色与发布权限均由服务端校验。</p>
        </div>
        <Badge variant="secondary" className="gap-1.5">
          <ShieldCheck />
          {isSuperAdmin ? "超级管理员" : "管理员"}
        </Badge>
      </header>

      <Tabs defaultValue={isSuperAdmin ? "users" : "publishers"}>
        <TabsList>
          {isSuperAdmin ? <TabsTrigger value="users">账户权限</TabsTrigger> : null}
          <TabsTrigger value="publishers">发布者</TabsTrigger>
        </TabsList>
        {isSuperAdmin ? (
          <TabsContent value="users" className="mt-5">
            <UserAdminPanel users={users.data?.users ?? []} token={token} error={users.error} />
          </TabsContent>
        ) : null}
        <TabsContent value="publishers" className="mt-5">
          <PublisherAdminPanel publishers={publishers.data?.publishers ?? []} token={token} error={publishers.error} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function UserAdminPanel({ users, token, error }: { users: AdminUser[]; token: string; error: Error | null }) {
  return (
    <section className="grid gap-4" aria-labelledby="accounts-heading">
      <div>
        <h2 id="accounts-heading" className="text-base font-semibold">
          账户权限
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">至少保留一个超级管理员账户。</p>
      </div>
      {error ? <ErrorAlert error={error} /> : null}
      <div className="overflow-hidden rounded-md border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>账户</TableHead>
              <TableHead>角色</TableHead>
              <TableHead>创建时间</TableHead>
              <TableHead className="w-16 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((user) => (
              <UserRoleRow user={user} token={token} key={user.id} />
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

function UserRoleRow({ user, token }: { user: AdminUser; token: string }) {
  const [role, setRole] = useState<UserRole>(user.role);
  const mutation = useUpdateAdminUserRole();
  useEffect(() => setRole(user.role), [user.role]);
  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-2">
          <span className="grid size-8 place-items-center rounded-md bg-muted text-muted-foreground">
            <UserCog size={15} />
          </span>
          <span className="font-medium">{user.username}</span>
        </div>
      </TableCell>
      <TableCell>
        <Select value={role} onValueChange={(value) => setRole(value as UserRole)}>
          <SelectTrigger className="w-44" aria-label={`${user.username} 的角色`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="user">普通用户</SelectItem>
            <SelectItem value="admin">管理员</SelectItem>
            <SelectItem value="super_admin">超级管理员</SelectItem>
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell className="text-muted-foreground">{new Date(user.createdAt).toLocaleString("zh-CN")}</TableCell>
      <TableCell className="text-right">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title="保存角色"
          disabled={role === user.role || mutation.isPending}
          onClick={() => mutation.mutate({ username: user.username, role, token })}
        >
          {mutation.isPending ? <LoaderCircle className="animate-spin" /> : <Save />}
        </Button>
      </TableCell>
    </TableRow>
  );
}

function PublisherAdminPanel({
  publishers,
  token,
  error,
}: {
  publishers: PublisherAdminView[];
  token: string;
  error: Error | null;
}) {
  const [publisherId, setPublisherId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [verified, setVerified] = useState(false);
  const mutation = useUpsertAdminPublisher();

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    try {
      await mutation.mutateAsync({ publisherId: publisherId.trim(), displayName: displayName.trim(), verified, token });
      setPublisherId("");
      setDisplayName("");
      setVerified(false);
    } catch {
      // Mutation state renders the error.
    }
  }

  return (
    <section className="grid gap-5" aria-labelledby="publishers-heading">
      <div>
        <h2 id="publishers-heading" className="text-base font-semibold">
          发布者与成员
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">创建发布主体，并将账户加入对应成员列表。</p>
      </div>
      <form
        className="grid items-end gap-3 border-y py-4 md:grid-cols-[220px_minmax(220px,1fr)_auto_auto]"
        onSubmit={submit}
      >
        <div className="grid gap-2">
          <Label htmlFor="publisher-id">发布者 ID</Label>
          <Input
            id="publisher-id"
            required
            pattern="[a-z0-9][a-z0-9._-]+"
            value={publisherId}
            onChange={(event) => setPublisherId(event.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="publisher-name">显示名称</Label>
          <Input
            id="publisher-name"
            required
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </div>
        <label htmlFor="publisher-verified" className="flex h-9 items-center gap-2 text-sm">
          <Checkbox
            id="publisher-verified"
            checked={verified}
            onCheckedChange={(checked) => setVerified(checked === true)}
          />
          已认证
        </label>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? <LoaderCircle className="animate-spin" /> : <Plus />}
          保存发布者
        </Button>
      </form>
      {error ? <ErrorAlert error={error} /> : null}
      {mutation.error ? <ErrorAlert error={mutation.error} /> : null}
      <div className="grid divide-y border-y">
        {publishers.map((publisher) => (
          <PublisherRow publisher={publisher} token={token} key={publisher.id} />
        ))}
      </div>
    </section>
  );
}

function PublisherRow({ publisher, token }: { publisher: PublisherAdminView; token: string }) {
  const [username, setUsername] = useState("");
  const mutation = useUpdateAdminPublisherMember();
  async function addMember(event: FormEvent): Promise<void> {
    event.preventDefault();
    try {
      await mutation.mutateAsync({ publisherId: publisher.id, username: username.trim(), operation: "add", token });
      setUsername("");
    } catch {
      // Mutation state renders the error.
    }
  }
  return (
    <article className="grid gap-4 py-5 lg:grid-cols-[240px_minmax(0,1fr)]">
      <div>
        <div className="flex items-center gap-2">
          <h3 className="font-medium">{publisher.displayName}</h3>
          {publisher.verified ? <Badge variant="secondary">已认证</Badge> : null}
        </div>
        <p className="mt-1 font-mono text-xs text-muted-foreground">{publisher.id}</p>
      </div>
      <div className="grid gap-3">
        <div className="flex flex-wrap gap-2">
          {publisher.members.length === 0 ? (
            <span className="text-sm text-muted-foreground">暂无成员</span>
          ) : (
            publisher.members.map((member) => (
              <span
                className="inline-flex h-8 items-center gap-1 rounded-md border bg-background pl-2.5 pr-1 text-sm"
                key={member}
              >
                {member}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={`移除成员 ${member}`}
                  disabled={mutation.isPending}
                  onClick={() =>
                    mutation.mutate({ publisherId: publisher.id, username: member, operation: "remove", token })
                  }
                >
                  <Trash2 />
                </Button>
              </span>
            ))
          )}
        </div>
        <form className="flex max-w-md gap-2" onSubmit={addMember}>
          <Input
            required
            aria-label={`为 ${publisher.displayName} 添加成员`}
            placeholder="输入用户名"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
          <Button type="submit" variant="outline" disabled={mutation.isPending}>
            <Plus />
            添加
          </Button>
        </form>
        {mutation.error ? <ErrorAlert error={mutation.error} /> : null}
      </div>
    </article>
  );
}

function ErrorAlert({ error }: { error: Error }) {
  return (
    <Alert variant="destructive">
      <CircleAlert />
      <AlertDescription>{errorMessage(error)}</AlertDescription>
    </Alert>
  );
}
