import type { ReactNode } from "react";
import { AppSidebar } from "@/components/layout/app-sidebar.tsx";
import { type ConsoleRoute, consolePageMetadata } from "@/components/layout/console-navigation.ts";
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage } from "@/components/ui/breadcrumb.tsx";
import { Separator } from "@/components/ui/separator.tsx";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar.tsx";

export function ConsoleShell({
  pathname,
  username,
  children,
  onNavigate,
  onSignOut,
}: {
  pathname: string;
  username?: string;
  children: ReactNode;
  onNavigate(to: ConsoleRoute | "/login"): void;
  onSignOut(): void;
}) {
  const page = consolePageMetadata(pathname);

  return (
    <SidebarProvider>
      <AppSidebar pathname={pathname} username={username} onNavigate={onNavigate} onSignOut={onSignOut} />
      <SidebarInset className="min-w-0 md:peer-data-[state=expanded]:ml-(--sidebar-width) md:peer-data-[state=collapsed]:ml-(--sidebar-width-icon)">
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 h-4" />
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>{page.label}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <span className="ml-2 hidden text-xs text-muted-foreground md:inline">{page.description}</span>
        </header>
        <div className="flex-1 bg-muted/30 p-4 md:p-6">
          <div className="mx-auto w-full max-w-[1440px]">{children}</div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
