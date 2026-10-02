import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'DistLab — distributed systems laboratory',
  description:
    'A deterministic, browser-local simulation engine for experimenting with distributed system behaviour.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
