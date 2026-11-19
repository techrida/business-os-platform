# Business OS Login V2

This image builds ZITADEL Login V2 v4.20.1 with the Business OS shell and form styles. Build it from the repository root with `docker build -f infra/login/Dockerfile .`. The `test` target runs the Login V2 unit tests against the same source patches and overlay.

## Password recovery

From the password step, **Forgot password?** asks ZITADEL to send its password-reset notification. Open the link in that email to set a new password and continue signing in. The link includes a one-time code. ZITADEL verifies the code, checks password policy, and runs the normal sign-in and multi-factor steps.

On a development stack, start the core services and run `pnpm seed`. The seed activates the Mailpit email provider at `mailpit:1025` and configures the staff login policy. Open the mail catcher at `https://mail.localhost` (or the configured `MAIL_HOST`). Test password changes using a disposable development account.

New instances default to `hidePasswordReset=false` and `ignoreUnknownUsernames=true`. For an existing instance, check those settings in ZITADEL's login policies, including organizations with a custom policy. The latter instructs Login V2 to use a generic response for unknown addresses. The reset form gives the same delivery instructions regardless of whether the account was found. Request timing and throttling remain controlled by ZITADEL and the deployment.

For production, set `ZITADEL_SMTP_HOST` (host and port) and `ZITADEL_SMTP_FROM` in the deployment environment before first startup with `compose.prod.yaml`. Use `ZITADEL_SMTP_TLS=true` for an encrypted connection. Set `ZITADEL_SMTP_USER` and `ZITADEL_SMTP_PASSWORD` together for an authenticated server, and optionally `ZITADEL_SMTP_FROM_NAME`. These settings bootstrap ZITADEL's native email provider. An existing instance keeps its stored provider. Use **Instance settings → Email Providers** to add, test, activate or rotate it, and verify that a reset notification reaches a real mailbox. The public auth routes already include the Login V2 URL used by the reset email. Compose sets `LOGIN_PUBLIC_ORIGIN` from `AUTH_HOST` so links use the public HTTPS origin even when the proxy and Login V2 use plain HTTP on the internal network. For a standalone image, set `LOGIN_PUBLIC_ORIGIN` to the browser-facing HTTPS origin.

## Footer and theme

Set `LOGIN_HELP_URL` and `LOGIN_PRIVACY_URL` as absolute HTTP(S) URLs in the Login V2 container environment. Each item is hidden when its setting is empty or invalid. The server reads them when rendering the layout, so the same image can run in different deployments.

Business OS renders light even when the device prefers dark. The shared `BOS_LIGHT_ONLY` constant in `apps/workspace/src/lib/theme-mode.ts` also controls Login V2. Keep any theme controls in downstream layouts behind this lock.
