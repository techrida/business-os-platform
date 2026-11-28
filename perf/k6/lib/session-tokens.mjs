// The caller owns this virtual user's sessions, including replacements for the next iteration.
export function sessionTokens(sessions, renew, now) {
  const tokens = {};
  for (const [role, session] of Object.entries(sessions)) {
    if (session.expiresAt <= now + 60000) sessions[role] = renew(role);
    tokens[role] = sessions[role].token;
  }
  return tokens;
}
