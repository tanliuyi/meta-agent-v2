import { createFileRoute } from "@tanstack/react-router";
import { DesktopRoute } from "../desktop-route.tsx";

export const Route = createFileRoute("/")({
  component: DesktopRoute,
});
