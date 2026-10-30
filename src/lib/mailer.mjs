// SMTP configuration.
//
// EMAIL_FROM is preferred, then SMTP_FROM, then the authenticated account.
// Port 465 is implicit TLS; 587 and 25 require STARTTLS. A local MTA on
// localhost needs no credentials.

export function resolveSmtpConfig(env = process.env) {
  const user = (env.SMTP_USER || env.GMAIL_USER || '').trim();
  // Strip internal/surrounding whitespace (Google shows App Passwords in
  // 4-character groups, which are easy to paste with spaces).
  const pass = (env.SMTP_PASS || env.GMAIL_PASS || '').replace(/\s+/g, '');
  const host = env.SMTP_HOST || 'smtp.gmail.com';
  const port = parseInt(env.SMTP_PORT || '465', 10);

  const secure = env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465;
  const isLocal = host === 'localhost' || host === '127.0.0.1';
  const requireTLS = !secure && !isLocal;
  const from = env.EMAIL_FROM || env.SMTP_FROM || user;

  return {
    host,
    port,
    secure,
    requireTLS,
    user,
    pass,
    from,
    isLocal,
    configured: Boolean((user && pass) || isLocal),
  };
}
