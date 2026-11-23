import { useState } from 'react';
import { createRoot } from 'react-dom/client';

import '@/styles/tokens.css';
import '@/styles/token-overrides.css';
import '@/styles/globals.css';

import { Combobox } from '@/components/ui/combobox';
import { DatePicker } from '@/components/ui/date-picker';
import { Dialog } from '@/components/ui/dialog';
import { RowMenu } from '@/components/ui/row-menu';
import { Select } from '@/components/ui/select';
import shell from '@/components/shell/shell.module.css';
import sidebar from '@/components/shell/sidebar.module.css';

/**
 * The app shell's real frame and sidebar CSS around a page long enough to scroll, with one of each
 * floating control on the page and the same set inside a dialog. Nothing here needs the stack, so
 * a browser test can scroll the page, open a control and measure whether the shell moved.
 */
const terms = [
  { value: 'net-15', label: 'Net 15' },
  { value: 'net-30', label: 'Net 30' },
  { value: 'net-60', label: 'Net 60' },
];

function Controls({ scope }: { scope: 'page' | 'dialog' }) {
  const [combo, setCombo] = useState('');
  const [open, setOpen] = useState(false);
  return (
    <div style={{ display: 'grid', gap: 16, padding: 16 }}>
      <Select aria-label={`${scope} terms`} options={terms} defaultValue="net-30" />
      <Combobox
        label={`${scope} company`}
        options={[
          { id: 'a', label: 'Acme' },
          { id: 'b', label: 'Birch' },
        ]}
        value={combo}
        onChange={setCombo}
        open={open}
        onOpenChange={setOpen}
      />
      <DatePicker aria-label={`${scope} date`} />
      <RowMenu label={`${scope} actions`} items={[{ href: '#one', label: 'One' }]} />
    </div>
  );
}

function App() {
  return (
    <div className={shell.frame}>
      <aside className={sidebar.sidebar} data-testid="sidebar">
        <div className={sidebar.top}>Brand</div>
        <nav className={sidebar.nav}>
          {Array.from({ length: 12 }, (_, i) => (
            <div key={i} style={{ padding: '8px 0' }}>
              Item {i}
            </div>
          ))}
        </nav>
        <div style={{ padding: 16, borderTop: '1px solid var(--border-default)' }}>User card</div>
      </aside>
      <div className={shell.column} data-testid="main">
        <main style={{ padding: 24 }}>
          <div style={{ height: 1400 }}>Long page content</div>
          <section data-testid="page-controls">
            <Controls scope="page" />
          </section>
          <Dialog
            trigger={<button type="button">Open dialog</button>}
            title="Change payment terms"
            footer={<span>Footer</span>}
          >
            <Controls scope="dialog" />
          </Dialog>
          <div style={{ height: 800 }}>More content</div>
        </main>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />);
