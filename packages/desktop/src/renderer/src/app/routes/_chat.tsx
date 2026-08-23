import { createFileRoute } from "@tanstack/react-router";
import { ChatLayout } from "../chat-layout.tsx";

export const Route = createFileRoute("/_chat")({ component: ChatLayout });
