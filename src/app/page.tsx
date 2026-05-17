import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/dal";

export default async function Home() {
  const user = await getCurrentUser();
  redirect(user ? "/runs" : "/demo");
}
