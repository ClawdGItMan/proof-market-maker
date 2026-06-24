import { NextResponse } from "next/server";
import { fetchDashboard } from "@/lib/supabase";

// Live poll endpoint for the client component. Always dynamic, never cached.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const data = await fetchDashboard(Date.now());
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
