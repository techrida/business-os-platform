import { BOS_LIGHT_ONLY } from '@bos/locale';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// Same order as apps/workspace: tokens, our overrides of them, the self-hosted font, then the
// base styles that use all three.
import '@/styles/tokens.css';
import '@/styles/token-overrides.css';
import '@fontsource-variable/outfit';
import '@/styles/globals.css';

import { TooltipProvider } from '@/components/ui/tooltip';

export const metadata: Metadata = {
  title: 'Customer portal - Business OS',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme={BOS_LIGHT_ONLY ? 'light' : undefined}>
      <body>
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}
