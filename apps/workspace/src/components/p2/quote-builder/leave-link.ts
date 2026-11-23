export type LeaveAction = { kind: 'push'; path: string } | { kind: 'assign'; href: string };

/**
 * How to follow a link the user chose to take after "Leave without saving?".
 * Another page of the app is a soft navigation. A link to another site, or back to this very
 * page, is a full load: the totals panel's "Reload the page" link points at the current URL because
 * Next runs server actions one at a time, so a soft navigation would queue behind the stuck one.
 */
export function leaveAction(href: string, currentHref: string): LeaveAction {
  const to = new URL(href, currentHref);
  const here = new URL(currentHref);
  if (to.origin !== here.origin) return { kind: 'assign', href: to.href };
  if (to.pathname === here.pathname && to.search === here.search) {
    return { kind: 'assign', href: to.href };
  }
  return { kind: 'push', path: `${to.pathname}${to.search}${to.hash}` };
}
