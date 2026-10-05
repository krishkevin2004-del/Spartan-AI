import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Housing Handbook Assistant",
  description: "Instant, cited answers to MSU on-campus housing policy questions, straight from the official handbook.",
  robots: { index: false }, // pilot: keep it out of search engines
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover", // use the full phone screen, with safe-area padding in the CSS
  interactiveWidget: "resizes-content", // Android: shrink the page when the keyboard opens
  themeColor: "#ffffff", // matches the white strip at the top
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
