import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Neon Peak Crash - Crypto Multiplier Game",
  description: "A high-stakes multiplier prediction game with real-time charting, AI insights, and a sleek neon aesthetic.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Inter:wght@400;600;800&display=swap" rel="stylesheet" />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
