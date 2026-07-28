import { useNavigate } from "@tanstack/react-router";
import { CircleAlert, LoaderCircle, LogIn, Star, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useCurrentUser, useDeleteRating, usePluginRatings, useRatePlugin, useSession } from "@/api-hooks.ts";
import { Alert, AlertDescription } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Label } from "@/components/ui/label.tsx";
import { Separator } from "@/components/ui/separator.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { dateFormatter, errorMessage } from "@/lib/marketplace-ui.ts";

export function PluginRatingsPanel({ pluginId }: { pluginId: string }) {
  const navigate = useNavigate();
  const { data: session } = useSession();
  const token = session?.token ?? null;
  const { data: user } = useCurrentUser(token);
  const ratingsQuery = usePluginRatings(pluginId);
  const rateMutation = useRatePlugin();
  const deleteMutation = useDeleteRating();
  const [stars, setStars] = useState(0);
  const [review, setReview] = useState("");

  const ownRating = ratingsQuery.data?.ratings.find((entry) => entry.username === user?.user?.username);
  useEffect(() => {
    setStars(ownRating?.stars ?? 0);
    setReview(ownRating?.review ?? "");
  }, [ownRating]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!token || !stars) return;
    try {
      await rateMutation.mutateAsync({ pluginId, stars, review, token });
    } catch {
      // Mutation state renders the error.
    }
  }

  async function remove(): Promise<void> {
    if (!token) return;
    try {
      await deleteMutation.mutateAsync({ pluginId, token });
    } catch {
      // Mutation state renders the error.
    }
  }

  return (
    <div className="space-y-6">
      {token && user?.user ? (
        <form className="grid gap-4 rounded-lg border bg-muted/20 p-4" onSubmit={submit}>
          <fieldset className="grid gap-2">
            <legend className="text-sm font-medium">你的评分</legend>
            <div className="flex gap-1">
              {[1, 2, 3, 4, 5].map((value) => (
                <Button
                  variant="ghost"
                  size="icon"
                  type="button"
                  aria-pressed={stars === value}
                  aria-label={`${value} 星`}
                  title={`${value} 星`}
                  onClick={() => setStars(value)}
                  key={value}
                >
                  <Star className="text-amber-600" fill={value <= stars ? "currentColor" : "none"} />
                </Button>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-2">
            <Label htmlFor="rating-review">评价</Label>
            <Textarea
              id="rating-review"
              value={review}
              onChange={(event) => setReview(event.target.value)}
              maxLength={2000}
              placeholder="写下你的使用体验（可选）"
            />
          </div>
          {rateMutation.isError || deleteMutation.isError ? (
            <Alert variant="destructive">
              <CircleAlert />
              <AlertDescription>{errorMessage(rateMutation.error ?? deleteMutation.error)}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex justify-end gap-2">
            {ownRating ? (
              <Button variant="outline" type="button" disabled={deleteMutation.isPending} onClick={remove}>
                {deleteMutation.isPending ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
                删除评价
              </Button>
            ) : null}
            <Button type="submit" disabled={!stars || rateMutation.isPending}>
              {rateMutation.isPending ? <LoaderCircle className="animate-spin" /> : <Star />}
              保存评分
            </Button>
          </div>
        </form>
      ) : (
        <Button variant="outline" type="button" onClick={() => navigate({ to: "/login" })}>
          <LogIn />
          登录后评分
        </Button>
      )}

      <div>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">社区评价</h3>
          <span className="text-xs text-muted-foreground">{ratingsQuery.data?.rating.count ?? 0} 条</span>
        </div>
        <div className="mt-3">
          {ratingsQuery.data?.ratings.length ? (
            ratingsQuery.data.ratings.slice(0, 8).map((entry, index) => (
              <article className="py-4" key={`${entry.username}-${entry.updatedAt}`}>
                {index ? <Separator className="mb-4" /> : null}
                <div className="flex items-center gap-2 text-xs">
                  <strong className="font-medium">{entry.username}</strong>
                  <span className="inline-flex items-center gap-1 text-amber-600">
                    <Star size={13} fill="currentColor" />
                    {entry.stars}
                  </span>
                  <time className="ml-auto text-muted-foreground">{dateFormatter.format(entry.updatedAt)}</time>
                </div>
                {entry.review ? (
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{entry.review}</p>
                ) : null}
              </article>
            ))
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">暂无评价。</p>
          )}
        </div>
      </div>
    </div>
  );
}
