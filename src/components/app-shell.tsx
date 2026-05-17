import Link from "next/link";
import { getCurrentUser } from "@/lib/dal";
import { Button } from "@/components/ui/button";

export async function AppShell({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b bg-background">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <div className="flex items-center gap-6">
            <Link href="/runs" className="text-sm font-semibold">
              Prospect Engine
            </Link>
            <nav className="flex items-center gap-4 text-sm text-muted-foreground">
              <Link href="/runs" className="hover:text-foreground">
                Runs
              </Link>
              <Link href="/runs/new" className="hover:text-foreground">
                New run
              </Link>
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <span>{user?.email}</span>
            <form action="/auth/signout" method="post">
              <Button type="submit" size="sm" variant="ghost">
                Sign out
              </Button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</main>
    </div>
  );
}
