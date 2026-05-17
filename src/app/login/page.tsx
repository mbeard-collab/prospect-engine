import Link from "next/link";
import { signInWithMagicLink } from "./actions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; email?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const envMissing =
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Prospect Engine</CardTitle>
          <CardDescription>Sign in with a magic link.</CardDescription>
        </CardHeader>
        <CardContent>
          {envMissing ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              Supabase env vars are not set. Add
              <code className="mx-1 rounded bg-background px-1">NEXT_PUBLIC_SUPABASE_URL</code>
              and
              <code className="mx-1 rounded bg-background px-1">NEXT_PUBLIC_SUPABASE_ANON_KEY</code>
              to <code className="rounded bg-background px-1">.env.local</code> and restart the dev server.
            </div>
          ) : sp.sent ? (
            <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm">
              Magic link sent to <strong>{sp.email}</strong>. Check your inbox.
            </div>
          ) : (
            <form action={signInWithMagicLink} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="email">Work email</Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  placeholder="you@govspend.com"
                  required
                  autoComplete="email"
                />
              </div>
              {sp.error ? (
                <p className="text-sm text-destructive">
                  {sp.error === "invalid_email" ? "Enter a valid email address." : sp.error}
                </p>
              ) : null}
              <Button type="submit" className="w-full">
                Send magic link
              </Button>
            </form>
          )}
          <div className="mt-4 border-t pt-4 text-center text-xs text-muted-foreground">
            No account?{" "}
            <Link href="/demo" className="underline hover:text-foreground">
              Try the Stage 1 demo
            </Link>{" "}
            — runs in your browser, no sign-in.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
