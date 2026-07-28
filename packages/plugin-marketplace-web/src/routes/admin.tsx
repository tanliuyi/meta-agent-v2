import { createFileRoute } from "@tanstack/react-router";
import { SystemAdminPage } from "@/features/admin/system-admin-page.tsx";

export const Route = createFileRoute("/admin")({
  component: SystemAdminPage,
});
