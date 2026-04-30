import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Paper Tutor",
  description: "Multi-modal lessons from research papers.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
