import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { verifySession } from "@/lib/dal";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  running: "Running",
  complete: "Complete",
  failed: "Failed",
};

const STATUS_CLASS: Record<string, string> = {
  pending: "border-zinc-200 bg-zinc-50 text-zinc-700",
  running: "border-blue-200 bg-blue-50 text-blue-700",
  complete: "border-emerald-200 bg-emerald-50 text-emerald-700",
  failed: "border-red-200 bg-red-50 text-red-700",
};

export default async function RunsPage() {
  const { supabase } = await verifySession();
  const { data: runs, error } = await supabase
    .from("runs")
    .select("id, name, csv_filename, total_accounts, excluded_count, ready_count, status, created_at")
    .order("created_at", { ascending: false })
    .limit(50);

  return (
    <AppShell>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Runs</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Past CSV uploads and their pipeline state.
          </p>
        </div>
        <Link href="/runs/new" className={buttonVariants()}>
          New run
        </Link>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>History</CardTitle>
          <CardDescription>
            {error ? (
              <span className="text-destructive">{error.message}</span>
            ) : (
              `${runs?.length ?? 0} run${runs?.length === 1 ? "" : "s"}`
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!runs || runs.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No runs yet. Start with{" "}
              <Link href="/runs/new" className="underline">
                a new run
              </Link>
              .
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>File</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Excluded</TableHead>
                  <TableHead className="text-right">Ready</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">
                      <Link href={`/runs/${r.id}`} className="hover:underline">
                        {r.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {r.csv_filename ?? "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={STATUS_CLASS[r.status]}>
                        {STATUS_LABEL[r.status] ?? r.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.total_accounts}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.excluded_count}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.ready_count}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(r.created_at).toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </AppShell>
  );
}
