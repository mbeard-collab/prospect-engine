import { AppShell } from "@/components/app-shell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { verifySession } from "@/lib/dal";
import { createRun } from "./actions";

export default async function NewRunPage() {
  await verifySession();
  return (
    <AppShell>
      <div className="max-w-xl">
        <h1 className="text-2xl font-semibold tracking-tight">New run</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Upload a CSV of accounts. Stage 1 will auto-flag obvious Low Fit companies
          (construction, banks, law firms, etc.) before any external calls.
        </p>

        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Upload</CardTitle>
            <CardDescription>
              CSV must include a company name column. Up to 5&nbsp;MB.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form action={createRun} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="name">Run name</Label>
                <Input
                  id="name"
                  name="name"
                  required
                  placeholder="Q2 territory list"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="file">CSV file</Label>
                <Input
                  id="file"
                  name="file"
                  type="file"
                  accept=".csv,text/csv"
                  required
                />
              </div>
              <Button type="submit">Start Stage 1</Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
