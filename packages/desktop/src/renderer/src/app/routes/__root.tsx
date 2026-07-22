import { createRootRoute, Navigate, Outlet } from "@tanstack/react-router";

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: () => <Navigate to="/" replace />,
});

/** Route-agnostic window boundary. Route layouts own their navigation and content. */
function RootLayout() {
  return (
    <div className="app-frame" data-platform={window.desktop.platform}>
      <Outlet />
    </div>
  );
}
