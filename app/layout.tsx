import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Wilson Hall Handbook Assistant",
  description: "Instant, cited answers to MSU housing policy questions, straight from the official handbook.",
  robots: { index: false }, // pilot: keep it out of search engines
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#18453B",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
