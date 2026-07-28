import { createFileRoute } from "@tanstack/react-router";
import { CatalogPage } from "@/features/catalog/catalog-page.tsx";

export const Route = createFileRoute("/catalog")({
  component: CatalogPage,
});
