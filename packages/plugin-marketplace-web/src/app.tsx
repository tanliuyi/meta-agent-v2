import {
  ArrowDownToLine,
  BadgeCheck,
  Boxes,
  ChevronRight,
  CircleAlert,
  Download,
  LoaderCircle,
  LogIn,
  LogOut,
  Search,
  ShieldCheck,
  Star,
  UserRound,
  X,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card } from "@/components/ui/card.tsx";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.tsx";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import {
  type AuthMe,
  authenticate,
  deleteRating,
  getCurrentUser,
  getDownload,
  getPlugin,
  getRatings,
  listPlugins,
  logout,
  MarketplaceApiError,
  type PluginDetail,
  type PluginSummary,
  type PluginVersionDetail,
  type RatingsResponse,
  ratePlugin,
} from "./api.ts";

const SESSION_KEY = "meta-agent-marketplace-session";
const dateFormatter = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric" });
const numberFormatter = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 });

interface SessionState {
  token: string;
  expiresAt: number;
}

interface DetailPanelProps {
  pluginId: string;
  session?: SessionState;
  user?: AuthMe;
  onClose(): void;
  onRequestLogin(): void;
  onRatingChanged(pluginId: string, rating: PluginSummary["rating"]): void;
}

interface AuthDialogProps {
  onClose(): void;
  onAuthenticated(session: SessionState, user: AuthMe): void;
}

export function App() {
  const [plugins, setPlugins] = useState<PluginSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string>();
  const [selectedPluginId, setSelectedPluginId] = useState<string>();
  const [authOpen, setAuthOpen] = useState(false);
  const [session, setSession] = useState<SessionState | undefined>(() => readSession());
  const [user, setUser] = useState<AuthMe>();

  useEffect(() => {
    if (!session) {
      setUser(undefined);
      return;
    }
    let active = true;
    getCurrentUser(session.token)
      .then((nextUser) => {
        if (active) setUser(nextUser);
      })
      .catch(() => {
        if (!active) return;
        clearSession();
        setSession(undefined);
      });
    return () => {
      active = false;
    };
  }, [session]);

  useEffect(() => {
    let active = true;
    const timeout = window.setTimeout(
      () => {
        setLoading(true);
        setError(undefined);
        listPlugins({ query: query.trim() || undefined, category: category || undefined })
          .then((page) => {
            if (!active) return;
            setPlugins(page.plugins);
            setNextCursor(page.nextCursor);
          })
          .catch((reason: unknown) => {
            if (active) setError(errorMessage(reason));
          })
          .finally(() => {
            if (active) setLoading(false);
          });
      },
      query ? 250 : 0,
    );
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [query, category]);

  const categories = useMemo(
    () => [...new Set(plugins.flatMap((plugin) => plugin.categories))].sort((left, right) => left.localeCompare(right)),
    [plugins],
  );

  async function loadMore(): Promise<void> {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(undefined);
    try {
      const page = await listPlugins({
        query: query.trim() || undefined,
        category: category || undefined,
        cursor: nextCursor,
      });
      setPlugins((current) => [...current, ...page.plugins]);
      setNextCursor(page.nextCursor);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoadingMore(false);
    }
  }

  async function signOut(): Promise<void> {
    const token = session?.token;
    clearSession();
    setSession(undefined);
    if (token) await logout(token).catch(() => undefined);
  }

  function updateRating(pluginId: string, rating: PluginSummary["rating"]): void {
    setPlugins((current) => current.map((plugin) => (plugin.id === pluginId ? { ...plugin, rating } : plugin)));
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Meta Agent 插件市场首页">
          <span className="brand-mark" aria-hidden="true">
            <Boxes size={19} strokeWidth={2.2} />
          </span>
          <span>
            <strong>Meta Agent</strong>
            <small>插件市场</small>
          </span>
        </a>
        <div className="account-actions">
          {user?.user ? (
            <>
              <span className="account-name">
                <UserRound size={16} />
                {user.user.username}
              </span>
              <Button
                variant="ghost"
                size="icon"
                type="button"
                onClick={signOut}
                aria-label="退出登录"
                title="退出登录"
              >
                <LogOut size={18} />
              </Button>
            </>
          ) : (
            <Button variant="outline" type="button" onClick={() => setAuthOpen(true)}>
              <LogIn size={17} />
              登录
            </Button>
          )}
        </div>
      </header>

      <main>
        <section className="market-header" aria-labelledby="market-title">
          <div>
            <p className="eyebrow">PLUGIN DIRECTORY</p>
            <h1 id="market-title">发现可信的 Meta Agent 插件</h1>
            <p>浏览由市场签名并验证的扩展，查看兼容性、权限和版本记录。</p>
          </div>
          <div className="trust-note">
            <ShieldCheck size={21} />
            <span>
              <strong>签名分发</strong>
              <small>下载内容由市场 Ed25519 密钥签名</small>
            </span>
          </div>
        </section>

        <section className="catalog-toolbar" aria-label="插件筛选">
          <div className="search-field">
            <Search size={18} aria-hidden="true" />
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索插件、描述或发布者"
              aria-label="搜索插件"
            />
            {query ? (
              <Button
                variant="ghost"
                size="icon"
                type="button"
                onClick={() => setQuery("")}
                aria-label="清除搜索"
                title="清除搜索"
              >
                <X size={16} />
              </Button>
            ) : null}
          </div>
          <div className="category-select">
            <span>分类</span>
            <Select value={category || "all"} onValueChange={(value) => setCategory(value === "all" ? "" : value)}>
              <SelectTrigger aria-label="选择分类">
                <SelectValue placeholder="全部分类" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部分类</SelectItem>
                {categories.map((entry) => (
                  <SelectItem value={entry} key={entry}>
                    {categoryLabel(entry)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <span className="result-count">{loading ? "正在查询" : `${plugins.length} 个插件`}</span>
        </section>

        {error ? (
          <div className="notice error" role="alert">
            <CircleAlert size={18} />
            <span>{error}</span>
            <Button variant="link" size="sm" type="button" onClick={() => window.location.reload()}>
              重试
            </Button>
          </div>
        ) : null}

        {loading ? (
          <output className="loading-state">
            <LoaderCircle className="spin" size={24} />
            正在加载插件目录
          </output>
        ) : plugins.length === 0 ? (
          <div className="empty-state">
            <Search size={28} />
            <h2>没有找到匹配的插件</h2>
            <p>调整搜索内容或分类后重试。</p>
          </div>
        ) : (
          <section className="plugin-grid" aria-label="插件列表">
            {plugins.map((plugin) => (
              <PluginCard plugin={plugin} key={plugin.id} onOpen={() => setSelectedPluginId(plugin.id)} />
            ))}
          </section>
        )}

        {nextCursor ? (
          <div className="load-more">
            <Button variant="outline" type="button" disabled={loadingMore} onClick={loadMore}>
              {loadingMore ? <LoaderCircle className="spin" size={17} /> : <ArrowDownToLine size={17} />}
              加载更多
            </Button>
          </div>
        ) : null}
      </main>

      <footer>
        <span>Meta Agent Plugin Marketplace</span>
        <span>协议版本 v1</span>
      </footer>

      {selectedPluginId ? (
        <DetailPanel
          pluginId={selectedPluginId}
          session={session}
          user={user}
          onClose={() => setSelectedPluginId(undefined)}
          onRequestLogin={() => setAuthOpen(true)}
          onRatingChanged={updateRating}
        />
      ) : null}

      {authOpen ? (
        <AuthDialog
          onClose={() => setAuthOpen(false)}
          onAuthenticated={(nextSession, nextUser) => {
            writeSession(nextSession);
            setSession(nextSession);
            setUser(nextUser);
            setAuthOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function PluginCard({ plugin, onOpen }: { plugin: PluginSummary; onOpen(): void }) {
  return (
    <Button variant="outline" className="plugin-card" type="button" onClick={onOpen}>
      <span className="plugin-card-head">
        <PluginIcon name={plugin.name} />
        <span className="plugin-card-title">
          <span>
            <strong>{plugin.name}</strong>
            {plugin.publisher.verified ? <BadgeCheck size={15} aria-label="已认证发布者" /> : null}
          </span>
          <small>{plugin.publisher.displayName}</small>
        </span>
        <ChevronRight size={18} className="card-chevron" aria-hidden="true" />
      </span>
      <span className="plugin-description">{plugin.description}</span>
      <span className="tag-row">
        {plugin.categories.slice(0, 3).map((entry) => (
          <Badge variant="outline" className="tag" key={entry}>
            {categoryLabel(entry)}
          </Badge>
        ))}
      </span>
      <span className="plugin-card-meta">
        <span className="rating-inline">
          <Star size={15} fill={plugin.rating.count ? "currentColor" : "none"} />
          {plugin.rating.average === null ? "暂无评分" : plugin.rating.average.toFixed(1)}
          {plugin.rating.count ? <small>({plugin.rating.count})</small> : null}
        </span>
        <span>
          <Download size={15} />
          {numberFormatter.format(plugin.downloadCount)}
        </span>
        <span className="version-label">v{plugin.latestVersion ?? "-"}</span>
      </span>
    </Button>
  );
}

function DetailPanel({ pluginId, session, user, onClose, onRequestLogin, onRatingChanged }: DetailPanelProps) {
  const [plugin, setPlugin] = useState<PluginDetail>();
  const [ratings, setRatings] = useState<RatingsResponse>();
  const [selectedVersion, setSelectedVersion] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [downloading, setDownloading] = useState<string>();
  const [stars, setStars] = useState(0);
  const [review, setReview] = useState("");
  const [savingRating, setSavingRating] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([getPlugin(pluginId), getRatings(pluginId)])
      .then(([nextPlugin, nextRatings]) => {
        if (!active) return;
        setPlugin(nextPlugin);
        setRatings(nextRatings);
        setSelectedVersion(nextPlugin.latestVersion ?? nextPlugin.versions[0]?.version);
      })
      .catch((reason: unknown) => {
        if (active) setError(errorMessage(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [pluginId]);

  const ownRating = ratings?.ratings.find((entry) => entry.username === user?.user?.username);
  useEffect(() => {
    setStars(ownRating?.stars ?? 0);
    setReview(ownRating?.review ?? "");
  }, [ownRating]);

  const version = plugin?.versions.find((entry) => entry.version === selectedVersion) ?? plugin?.versions[0];

  async function downloadArtifact(versionDetail: PluginVersionDetail, artifactId: string): Promise<void> {
    setDownloading(artifactId);
    setError(undefined);
    try {
      const metadata = await getDownload(pluginId, versionDetail.version, artifactId);
      window.location.assign(metadata.url);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setDownloading(undefined);
    }
  }

  async function submitRating(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!session || !stars || savingRating) return;
    setSavingRating(true);
    setError(undefined);
    try {
      await ratePlugin(pluginId, stars, review, session.token);
      const nextRatings = await getRatings(pluginId);
      setRatings(nextRatings);
      onRatingChanged(pluginId, nextRatings.rating);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSavingRating(false);
    }
  }

  async function removeRating(): Promise<void> {
    if (!session || savingRating) return;
    setSavingRating(true);
    try {
      await deleteRating(pluginId, session.token);
      const nextRatings = await getRatings(pluginId);
      setRatings(nextRatings);
      onRatingChanged(pluginId, nextRatings.rating);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSavingRating(false);
    }
  }

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="detail-panel" aria-label="插件详情">
        {loading ? (
          <div className="loading-state fill">
            <LoaderCircle className="spin" size={24} />
            正在加载详情
          </div>
        ) : error && !plugin ? (
          <div className="empty-state">
            <CircleAlert size={28} />
            <h2>无法加载插件</h2>
            <p>{error}</p>
          </div>
        ) : plugin ? (
          <>
            <SheetHeader className="detail-header">
              <PluginIcon name={plugin.name} large />
              <div>
                <div className="detail-title-row">
                  <SheetTitle>{plugin.name}</SheetTitle>
                  {plugin.publisher.verified ? <BadgeCheck size={18} aria-label="已认证发布者" /> : null}
                </div>
                <SheetDescription>
                  {plugin.publisher.displayName} · {plugin.id}
                </SheetDescription>
              </div>
            </SheetHeader>
            <div className="detail-content">
              {error ? (
                <div className="notice error">
                  <CircleAlert size={17} />
                  {error}
                </div>
              ) : null}
              <p className="detail-description">{plugin.description}</p>
              <dl className="stats-strip">
                <div>
                  <dt>评分</dt>
                  <dd>
                    <Star size={15} fill="currentColor" />
                    {plugin.rating.average?.toFixed(1) ?? "-"}
                    <small>{plugin.rating.count} 条</small>
                  </dd>
                </div>
                <div>
                  <dt>下载</dt>
                  <dd>{numberFormatter.format(plugin.downloadCount)}</dd>
                </div>
                <div>
                  <dt>更新</dt>
                  <dd>{dateFormatter.format(plugin.updatedAt)}</dd>
                </div>
              </dl>

              <section className="detail-section">
                <div className="section-heading">
                  <h3>版本与下载</h3>
                  <Select value={version?.version} onValueChange={setSelectedVersion}>
                    <SelectTrigger size="sm" className="version-select" aria-label="选择版本">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {plugin.versions.map((entry) => (
                        <SelectItem value={entry.version} key={entry.version}>
                          v{entry.version}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {version ? (
                  <VersionView version={version} downloading={downloading} onDownload={downloadArtifact} />
                ) : (
                  <p className="muted">暂无公开版本。</p>
                )}
              </section>

              <section className="detail-section">
                <h3>分类</h3>
                <div className="tag-row">
                  {plugin.categories.map((entry) => (
                    <Badge variant="outline" className="tag" key={entry}>
                      {categoryLabel(entry)}
                    </Badge>
                  ))}
                </div>
              </section>

              <section className="detail-section rating-section">
                <div className="section-heading">
                  <h3>社区评分</h3>
                  <span className="muted">{ratings?.rating.count ?? 0} 条评价</span>
                </div>
                {session && user?.user ? (
                  <form className="rating-form" onSubmit={submitRating}>
                    <fieldset className="star-picker" aria-label="评分">
                      {[1, 2, 3, 4, 5].map((value) => (
                        <label key={value} title={`${value} 星`}>
                          <input
                            type="radio"
                            name="stars"
                            value={value}
                            checked={stars === value}
                            onChange={() => setStars(value)}
                          />
                          <Star size={23} fill={value <= stars ? "currentColor" : "none"} />
                          <span className="visually-hidden">{value} 星</span>
                        </label>
                      ))}
                    </fieldset>
                    <Textarea
                      value={review}
                      onChange={(event) => setReview(event.target.value)}
                      maxLength={2000}
                      placeholder="写下你的使用体验（可选）"
                      aria-label="评价内容"
                    />
                    <div className="form-actions">
                      {ownRating ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-button danger"
                          type="button"
                          onClick={removeRating}
                          disabled={savingRating}
                        >
                          删除评价
                        </Button>
                      ) : (
                        <span />
                      )}
                      <Button type="submit" disabled={!stars || savingRating}>
                        {savingRating ? <LoaderCircle className="spin" size={16} /> : <Star size={16} />}保存评分
                      </Button>
                    </div>
                  </form>
                ) : (
                  <Button variant="outline" className="login-prompt" type="button" onClick={onRequestLogin}>
                    <LogIn size={17} />
                    登录后可以评分和撰写评价
                  </Button>
                )}
                <div className="review-list">
                  {ratings?.ratings.slice(0, 8).map((entry) => (
                    <article className="review" key={`${entry.username}-${entry.updatedAt}`}>
                      <div>
                        <strong>{entry.username}</strong>
                        <span className="review-stars">
                          <Star size={13} fill="currentColor" />
                          {entry.stars}
                        </span>
                        <time>{dateFormatter.format(entry.updatedAt)}</time>
                      </div>
                      {entry.review ? <p>{entry.review}</p> : null}
                    </article>
                  ))}
                </div>
              </section>
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function VersionView({
  version,
  downloading,
  onDownload,
}: {
  version: PluginVersionDetail;
  downloading?: string;
  onDownload(version: PluginVersionDetail, artifactId: string): void;
}) {
  return (
    <Card className="version-view">
      <div className="version-meta">
        <StatusBadge status={version.status} />
        <span>{dateFormatter.format(version.publishedAt)}</span>
        <span>Desktop {version.desktop.minVersion ? `≥ ${version.desktop.minVersion}` : "不限版本"}</span>
      </div>
      <p>{version.changelog}</p>
      {version.capabilities.length ? (
        <div className="capabilities">
          <strong>权限</strong>
          <div className="tag-row">
            {version.capabilities.map((capability) => (
              <Badge variant="outline" className="tag technical" key={capability}>
                {capability}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}
      <div className="artifact-list">
        {version.artifacts.map((artifact) => (
          <div className="artifact-row" key={artifact.id}>
            <div>
              <strong>
                {artifact.target.platform} / {artifact.target.arch}
              </strong>
              <small>
                {formatBytes(artifact.size)}
                {artifact.containsNativeCode ? " · 包含原生代码" : ""}
              </small>
            </div>
            <Button
              variant="outline"
              size="icon"
              type="button"
              disabled={downloading === artifact.id || version.status === "blocked" || version.status === "withdrawn"}
              onClick={() => onDownload(version, artifact.id)}
              aria-label={`下载 ${artifact.id}`}
              title="下载插件包"
            >
              {downloading === artifact.id ? <LoaderCircle className="spin" size={18} /> : <Download size={18} />}
            </Button>
          </div>
        ))}
      </div>
    </Card>
  );
}

function AuthDialog({ onClose, onAuthenticated }: AuthDialogProps) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const auth = await authenticate(mode, username.trim(), password);
      const session = { token: auth.token, expiresAt: auth.expiresAt };
      const currentUser = await getCurrentUser(auth.token);
      onAuthenticated(session, currentUser);
    } catch (reason) {
      setError(authErrorMessage(reason));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="auth-dialog">
        <DialogHeader>
          <span className="auth-icon">
            <UserRound size={22} />
          </span>
          <DialogTitle>{mode === "login" ? "登录市场账户" : "创建市场账户"}</DialogTitle>
          <DialogDescription>
            {mode === "login" ? "登录后可为插件评分并管理发布者权限。" : "用户名仅支持小写字母、数字和 ._-。"}
          </DialogDescription>
        </DialogHeader>
        <fieldset className="segmented-control" aria-label="账户操作">
          <Button
            variant={mode === "login" ? "secondary" : "ghost"}
            type="button"
            aria-pressed={mode === "login"}
            onClick={() => setMode("login")}
          >
            登录
          </Button>
          <Button
            variant={mode === "register" ? "secondary" : "ghost"}
            type="button"
            aria-pressed={mode === "register"}
            onClick={() => setMode("register")}
          >
            注册
          </Button>
        </fieldset>
        <form onSubmit={submit}>
          <label htmlFor="auth-username">
            <span>用户名</span>
            <Input
              id="auth-username"
              required
              minLength={3}
              maxLength={64}
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <label htmlFor="auth-password">
            <span>密码</span>
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
          </label>
          {error ? (
            <div className="notice error">
              <CircleAlert size={17} />
              {error}
            </div>
          ) : null}
          <Button className="wide" type="submit" disabled={submitting}>
            {submitting ? <LoaderCircle className="spin" size={17} /> : <LogIn size={17} />}
            {mode === "login" ? "登录" : "创建账户"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PluginIcon({ name, large = false }: { name: string; large?: boolean }) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join("");
  return (
    <span className="plugin-icon" data-large={large || undefined} aria-hidden="true">
      {initials || "P"}
    </span>
  );
}

function StatusBadge({ status }: { status: PluginVersionDetail["status"] }) {
  const labels = { available: "可用", deprecated: "已弃用", withdrawn: "已撤回", blocked: "已阻止" };
  return (
    <Badge className="status-badge" data-status={status}>
      {labels[status]}
    </Badge>
  );
}

function categoryLabel(category: string): string {
  const labels: Record<string, string> = {
    productivity: "效率",
    "developer-tools": "开发工具",
    communication: "沟通",
    automation: "自动化",
  };
  return labels[category] ?? category;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function readSession(): SessionState | undefined {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Partial<SessionState>;
    if (typeof value.token !== "string" || typeof value.expiresAt !== "number" || value.expiresAt <= Date.now()) {
      clearSession();
      return undefined;
    }
    return { token: value.token, expiresAt: value.expiresAt };
  } catch {
    clearSession();
    return undefined;
  }
}

function writeSession(session: SessionState): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
}

function errorMessage(reason: unknown): string {
  if (reason instanceof MarketplaceApiError) return reason.message;
  if (reason instanceof TypeError) return "无法连接插件市场服务，请确认 API 地址与网络状态。";
  return reason instanceof Error ? reason.message : "请求失败，请稍后重试。";
}

function authErrorMessage(reason: unknown): string {
  if (reason instanceof MarketplaceApiError) {
    if (reason.code === "AUTH_INVALID") return "用户名或密码不正确。";
    if (reason.code === "AUTH_RATE_LIMITED") return "登录尝试过多，请稍后再试。";
    if (reason.code === "REGISTRATION_DISABLED") return "当前市场未开放账户注册。";
    if (reason.code === "USER_EXISTS") return "该用户名已被使用。";
  }
  return errorMessage(reason);
}
