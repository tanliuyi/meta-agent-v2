import { createRootRoute, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAuthLogout, useCurrentUser, useSession } from "@/api-hooks.ts";
import type { ConsoleRoute } from "@/components/layout/console-navigation.ts";
import { ConsoleShell } from "@/components/layout/console-shell.tsx";

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const sessionQuery = useSession();
  const token = sessionQuery.data?.token ?? null;
  const { data: user } = useCurrentUser(token);
  const logoutMutation = useAuthLogout();
  const navigate = useNavigate();

  useEffect(() => {
    const protectedRoute = pathname === "/" || pathname === "/manage";
    if (!sessionQuery.isPending && !token && protectedRoute) navigate({ to: "/login", replace: true });
  }, [navigate, pathname, sessionQuery.isPending, token]);

  if (pathname === "/login") {
    return (
      <div className="min-h-screen bg-muted/30">
        <Outlet />
      </div>
    );
  }

  async function signOut(): Promise<void> {
    if (!token) return;
    try {
      await logoutMutation.mutateAsync(token);
    } catch {
      // Local session cleanup runs in the mutation's onSettled handler.
    }
    navigate({ to: "/login" });
  }

  function goTo(to: ConsoleRoute | "/login"): void {
    navigate({ to });
  }

  return (
    <ConsoleShell pathname={pathname} username={user?.user?.username} onNavigate={goTo} onSignOut={signOut}>
      <Outlet />
    </ConsoleShell>
  );
}
