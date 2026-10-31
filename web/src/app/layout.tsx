import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Overview · Resend ATO", template: "%s · Resend ATO" },
  description: "Account takeover investigations and analyst reviews.",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
