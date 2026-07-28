import { createFileRoute, redirect } from "@tanstack/react-router";
import { PublisherDashboard } from "@/features/dashboard/publisher-dashboard.tsx";
import { readSession } from "@/lib/marketplace-ui.ts";

export const Route = createFileRoute("/")({
  beforeLoad: () => {
    if (!readSession()) throw redirect({ to: "/login" });
  },
  component: PublisherDashboard,
});
