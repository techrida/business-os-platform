import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { InviteForm } from './invite-form';

vi.mock('server-only', () => ({}));
vi.mock('./actions', () => ({ inviteUserAction: vi.fn() }));

describe('Add New User department and level (F1-Q50)', () => {
  it('offers no department, the active departments and the three levels to someone who may place people', () => {
    const html = renderToStaticMarkup(
      <InviteForm
        departments={[
          { id: '00000000-0000-4000-8000-0000000005a1', name: 'Sales' },
          { id: '00000000-0000-4000-8000-0000000005a2', name: 'Finance' },
        ]}
      />,
    );
    expect(html).toContain('Department');
    expect(html).toContain('Level');
    expect(html).toContain('name="departmentId"');
    expect(html).toContain('name="level"');
  });

  it('leaves both fields out for someone who may not place people', () => {
    const html = renderToStaticMarkup(<InviteForm departments={null} />);
    expect(html).not.toContain('name="departmentId"');
    expect(html).not.toContain('name="level"');
  });
});
