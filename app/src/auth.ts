import { createMiddleware } from 'hono/factory';
import { config } from './config.js';

export type AppEnv = { Variables: { user: string } };

// The app never sees a password. TinyAuth (or any auth proxy) authenticates
// the browser and NGINX forwards the username in a header; we trust it.
export const auth = createMiddleware<AppEnv>(async (c, next) => {
  if (config.authMode === 'none') {
    c.set('user', 'local');
    return next();
  }

  if (config.authProxySecret) {
    const got = c.req.header('X-Proxy-Secret');
    if (got !== config.authProxySecret) {
      return c.text('Forbidden: request did not come through the auth proxy.', 403);
    }
  }

  const user = c.req.header(config.authUserHeader)?.trim();
  if (!user) {
    return c.text(
      `Not authenticated. ${config.siteName} expects to run behind an auth proxy ` +
        `(TinyAuth, Authelia, ...) that sets the ${config.authUserHeader} header. ` +
        `For LAN-only use without a proxy set AUTH_MODE=none.`,
      401,
    );
  }
  if (config.allowedUsers.length && !config.allowedUsers.includes(user)) {
    return c.text(`Forbidden: ${user} is not in ALLOWED_USERS.`, 403);
  }
  c.set('user', user);
  await next();
});
