import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Proof MM — Ops Dashboard",
  description: "Read-only operations dashboard for the Proof market maker",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-mono antialiased">{children}</body>
    </html>
  );
}
