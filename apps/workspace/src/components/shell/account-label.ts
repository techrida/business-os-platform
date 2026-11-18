/** Role keys stay in the session. The shell shows readable labels. */
export function accountLabel(roles: readonly string[]): string {
  return roles
    .map((role) =>
      role.replace(/[_-]+/g, ' ').replace(/(?:^|\s)\p{L}/gu, (start) => start.toUpperCase()),
    )
    .join(', ');
}
