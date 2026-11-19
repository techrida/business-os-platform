import { redirect } from 'next/navigation';

// Old bookmark and notification links keep working: forward to the new home, keeping the filters.
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<never> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      query.append(key, item);
    }
  }
  redirect(query.size > 0 ? `/settings/users?${query}` : '/settings/users');
}
