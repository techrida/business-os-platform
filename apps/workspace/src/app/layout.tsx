import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// Order matters: tokens first, our deliberate overrides of them, then the self-hosted font, then
// the base styles that use all three.
import '@/styles/tokens.css';
import '@/styles/token-overrides.css';
import '@fontsource-variable/outfit';
import '@/styles/globals.css';

export const metadata: Metadata = {
  title: 'Business OS',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
