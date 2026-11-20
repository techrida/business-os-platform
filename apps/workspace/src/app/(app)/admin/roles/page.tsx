import { redirect } from 'next/navigation';

// Old bookmark and notification links keep working: this page only forwards to its new home.
export default function Page(): never {
  redirect('/settings/access/roles');
}
