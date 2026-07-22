import { createFileRoute } from "@tanstack/react-router";
import { NewSessionRoute } from "../../components/new-session-route.tsx";

export const Route = createFileRoute("/new")({ component: NewSessionRoute });
