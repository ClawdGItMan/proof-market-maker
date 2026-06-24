import { fetchDashboard } from "@/lib/supabase";
import type { DashboardData } from "@/lib/types";
import { LiveDashboard } from "./components/LiveDashboard";

// Always render fresh on the server — this is a live ops view.
export const dynamic = "force-dynamic";

export default async function Page() {
  let initial: DashboardData;
  try {
    initial = await fetchDashboard(Date.now());
  } catch (e) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16 text-center">
        <h1 className="text-xl font-bold text-hard">Dashboard misconfigured</h1>
        <p className="mt-2 text-sm text-muted">{String(e)}</p>
        <p className="mt-4 text-xs text-muted">
          Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local.
        </p>
      </main>
    );
  }
  return <LiveDashboard initial={initial} />;
}
