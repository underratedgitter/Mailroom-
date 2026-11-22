# Mailroom

Send a newsletter to your list from **your own mailbox**. Pick a template, paste
or load recipients, preview the real message, send. Runs on your machine or your
own server — no accounts, no tracking pixels, no rewritten links, no third party
between you and your recipients.

```
        ┌──────────────┐
        │  your SMTP   │  Gmail · Fastmail · Postmark · your own relay
        └──────┬───────┘
               │
   template ───┼─── Mailroom (one small Node process)
   recipients ─┘        │
                        └── logs/sent.jsonl   (who got what, resumable)
```

## Requirements

- Node.js >= 20.6 (or Docker)

## Quick start

```bash
git clone <this repo> mailroom && cd mailroom
npm install
npm start          # or: npx mailroom
```

It prints `http://127.0.0.1:4173` and opens it. On first run Mailroom asks for
your SMTP details, tests the connection, and saves them — no file editing.

Global install:

```bash
npm install -g .
mailroom                  # --port 5000, --host 0.0.0.0, --no-open, --help
```

Docker:

```bash
docker build -t mailroom .
docker run -d --name mailroom \
  -e MAILROOM_PASSWORD_HASH='scrypt:...' \
  -e MAILROOM_TLS_CERT=/certs/fullchain.pem \
  -e MAILROOM_TLS_KEY=/certs/privkey.pem \
  -p 4173:4173 \
  -v "$PWD/certs:/certs:ro" \
  -v mailroom-config:/home/node/.mailroom \
  -v "$PWD/data:/app/data" \
  -v "$PWD/templates:/app/templates" \
  -v "$PWD/logs:/app/logs" \
  mailroom
```

The container binds `0.0.0.0`, so it needs the TLS pair (or the opt-out
described below) as well as a password. With the command above the app
is at `https://localhost:4173`.

The image runs as the unprivileged `node` user (uid 1000), not root. Named
volumes just work; a bind mount (`./data`, `./logs`, ...) must be writable by
uid 1000. Create the hash for `MAILROOM_PASSWORD_HASH` with:

```bash
docker run --rm -it mailroom node src/lib/auth.mjs
```

The container health check calls `/api/health`, which is open on purpose and
returns only `ok` and the version.

If TLS ends at a reverse proxy, keep the container on a private network and
allow plain HTTP only for that hop:

```bash
docker run -d --name mailroom \
  -e MAILROOM_PASSWORD_HASH='scrypt:...' \
  -e MAILROOM_ALLOW_INSECURE=1 \
  -e MAILROOM_TRUST_PROXY=1 \
  -p 127.0.0.1:4173:4173 \
  -v mailroom-config:/home/node/.mailroom \
  -v "$PWD/data:/app/data" \
  -v "$PWD/templates:/app/templates" \
  -v "$PWD/logs:/app/logs" \
  mailroom
```

A password (`MAILROOM_PASSWORD_HASH` or `MAILROOM_PASSWORD`) is required for any
non-loopback bind, including every Docker setup above: Mailroom refuses to
start without one, even with `MAILROOM_ALLOW_INSECURE=1`.

**Upgrading an existing container:** the config volume moved from
`/root/.mailroom` to `/home/node/.mailroom`. Mount the same volume at the new
path and make it writable by uid 1000 once, e.g.
`docker run --rm -v mailroom-config:/c alpine chown -R 1000:1000 /c`.

## HTTPS and network exposure

Loopback HTTP (`http://127.0.0.1:4173`) is the default and needs no setup.
Binding anywhere else requires encryption, because the login request and the
stored SMTP credentials would otherwise cross the network in plain text:

```bash
MAILROOM_TLS_CERT=/etc/mailroom/fullchain.pem \
MAILROOM_TLS_KEY=/etc/mailroom/privkey.pem \
GUI_HOST=0.0.0.0 \
MAILROOM_PASSWORD='a-long-passphrase' \
npm start
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `MAILROOM_PASSWORD_HASH` | unset | Salted scrypt hash of the GUI password (see below); preferred over `MAILROOM_PASSWORD` and wins if both are set |
| `MAILROOM_PASSWORD` | unset | Plaintext GUI password; still supported, hashed in memory at login time |
| `MAILROOM_SESSION_TTL_SECONDS` | `43200` (12 h) | How long a login lasts; the cookie and the server-side session both expire then |
| `MAILROOM_TRUST_PROXY` | unset | Set to `1` behind a reverse proxy you control: honours `X-Forwarded-Proto` (Secure cookie, HSTS), `X-Forwarded-Host` and `X-Forwarded-For` (login throttling) |
| `MAILROOM_TLS_CERT` | unset | Path to a PEM certificate (chain included if needed) |
| `MAILROOM_TLS_KEY` | unset | Path to the matching PEM private key |
| `MAILROOM_ALLOW_INSECURE` | unset | Set to `1` to permit a non-loopback plain-HTTP bind |
| `GUI_HOST` | `127.0.0.1` | Network interface to bind (CLI: `--host`) |
| `GUI_PORT` | `4173` | Port to listen on (CLI: `--port`) |
| `GUI_ALLOWED_HOSTS` | unset | Comma-separated list of additional allowed `Host` headers |
| `SEND_LOG_MAX_BYTES` | `10485760` | Size at which `logs/sent.jsonl` is rotated (`0` turns rotation off) |
| `SEND_LOG_KEEP` | `5` | Rotated archives kept (`sent.jsonl.1` is the newest); at least 1 |

Startup is validated before the port opens: a bad `GUI_PORT` / `--port`, a
non-numeric `SMTP_PORT`, `SMTP_SECURE` other than `true`/`false`, a bad
`SCHEDULE_GRACE_MS`, `SCHEDULER_INTERVAL_MS`, `SEND_LOG_MAX_BYTES` or
`SEND_LOG_KEEP`, a missing or unreadable `templates/` folder, or a `logs/`
folder that cannot be written all stop the process with one message listing
every problem. A missing SMTP user or password is not fatal for the browser
(you set it up there) and is shown in the startup banner; the CLI names the
missing variables and exits 1 for `--test` and `--send`.

### Hashing the password

A hash keeps the passphrase itself out of your config file, shell history,
`docker inspect` and process list:

```bash
node src/lib/auth.mjs            # prompts without echo; or pipe the password on stdin
# MAILROOM_PASSWORD_HASH=scrypt:32768:8:1:<salt>:<key>
```

Put that line in `.env` / `~/.mailroom/config.env` or pass it as an environment
variable. The hash is salted scrypt (N=32768, r=8, p=1) and is compared in
constant time. A malformed hash stops startup rather than leaving the app open.

**Migrating an existing install:** `MAILROOM_PASSWORD` keeps working unchanged
(Mailroom prints a reminder at startup). To switch, generate a hash for the same
passphrase, add `MAILROOM_PASSWORD_HASH=...` and delete the `MAILROOM_PASSWORD`
line; the passphrase people type does not change.

Set both TLS variables together; Mailroom refuses to start if only one is
present or if either file cannot be read. When TLS is active the session cookie
is marked `Secure`, so it is never sent over a plain-HTTP connection.

A non-loopback host over plain HTTP is refused at startup unless
`MAILROOM_ALLOW_INSECURE=1` is set. Use that opt-out only when a trusted reverse
proxy terminates TLS on the same private network; if you need the `Secure`
cookie flag, also set `MAILROOM_TRUST_PROXY=1` (and have the proxy send
`X-Forwarded-Proto: https`) or let Mailroom terminate TLS itself. `--host` and `GUI_HOST` keep
working exactly as before — they are just checked against this rule.

Upgrading: an existing Docker or LAN install that ran plain HTTP on
`0.0.0.0` must now add the TLS pair or `MAILROOM_ALLOW_INSECURE=1`, and must set
`MAILROOM_PASSWORD`. Startup fails with a message naming the missing setting
rather than silently serving credentials in the clear or an open relay.

## What it does

The browser app has a page for each step, in the sidebar: **Overview** (mailbox
status, counts, recent campaigns), **Compose**, **Recipients**, **Send**,
**Schedule**, **Suppression** and **Settings**. It follows your light or dark
system theme and works on a phone-sized screen.

**Compose** — every `templates/*.html` file is offered as a template. A folder
next to it named `<template>-assets/` (for example, `bcci-connect-v2-assets/`) is
picked up automatically and its images attached inline with `cid:` (Gmail blocks
`data:` URIs). Bundled templates include `bcci-connect-v2.html`,
`bcci-connect.html`, and `bcci-membership.html`.

**Recipients** — a saved `data/*.csv`, a CSV you upload, or addresses pasted straight in:

```
priya@example.com, Priya Shah, Sunrise Chemicals
Raj Patel <raj@patel.in>
ops@example.com	Ops Desk	Example Co
```

Invalid and duplicate lines are dropped as you type, and **Save as list** writes
the list into `data/` for next time. **Upload** checks a CSV before saving it and
shows how each column is used: the email column, `name` and `company` (with their
common aliases), and every other column as a `{{merge field}}` for the subject and
template. The Compose page flags any `{{field}}` the list cannot fill.

**Preview** — the actual rendered HTML for the selected recipient, images
included, with arrows to page through the list.

**Send** — a confirmation gate, then per-recipient progress over a live stream.
Re-running a campaign skips everyone it already mailed. Close the tab and the
send continues; reopen it and the page re-attaches.

**Schedule** — the **Schedule** page queues the same campaign for a later date
and time (in your machine's time zone). The queue lives in `logs/schedule.json`,
so it survives restarts; the page lists what is waiting, with *Send now* and
*Cancel* on each entry. The recipient list is snapshotted at the
moment you schedule it. Mailroom must be running when the time arrives — if it
was down, anything more than 30 minutes late is parked as **missed** in the
queue rather than going out stale, and you decide what to do with it. If the
process dies mid-send, that entry is put back in line on the next start. Only
one campaign runs at a time, so a scheduled send waits for any manual run to finish.

## Command line

```bash
npm run send -- \
  --csv data/recipients.example.csv \
  --html templates/bcci-connect-v2.html \
  --assets-dir templates/bcci-connect-v2-assets \
  --subject "BCCI Connect | November" \
  --campaign bcci-connect-nov-2026 \
  --send
```

`--test you@example.com` sends one message, `--dump out.html` renders without
sending, `--limit 100` caps the run, `--delay 4000` sets the gap.
`--suppress a@x.com,b@x.com` adds addresses to the [suppression
list](#deliverability-and-compliance) and exits. Scheduling is driven from the
browser, where the queue and its history can be seen.

## Sending a lot of mail

- **Gap between messages is 4 s** on the CLI, the browser and the API alike — a
  request that omits `delay` gets 4 s, not an unthrottled burst. `delay: 0` is
  honoured when you deliberately want the fastest run your provider allows.
- **Throughput is tamed by design**: one message at a time, one campaign at a
  time, and a rolling **500 messages/hour ceiling** (`MAX_PER_HOUR`, see
  [below](#deliverability-and-compliance)) that pauses the run instead of
  exceeding it. Measured against a local SMTP sink with this repo's template, a
  500 recipient run takes about 9 s with no gap and no ceiling. Your provider's
  rate limits still apply on top.
- **Provider daily caps still apply.** A free Gmail account stops at roughly 500
  recipients a day, and Google Workspace at 2 000 (1 500 in mail-merge mode;
  new accounts and some SMTP paths start lower). Mailroom stops the run when the
  server reports a quota or `5.4.5` error, and the campaign resumes where it
  stopped the next day. For lists beyond a few hundred, use a provider built for
  bulk (Postmark, SES, SendGrid, Mailgun) rather than a mailbox.
- **Keep messages small.** Inline images travel with every message; bundled
  templates with inlined images range from ~70 KB to ~800 KB per recipient, so
  large runs add up in upload bandwidth. Cut image weight (or host them) before
  a big run.
- **A broken link stops the run.** After 10 consecutive connection-level
  failures (network down, IP blocked, provider refusing) Mailroom stops instead
  of burning three retries per address down the list; the rest stay unsent and
  the campaign is resumable.
- **Resume is per campaign.** Re-running `campaign-x` skips everyone already
  logged as sent for `campaign-x`, so use a new campaign name for a new
  newsletter. The default name is the current month, which is right for a
  monthly send and wrong for two different mails in the same month.
- **Disk and memory**: the send log grows by ~100 bytes per recipient and is
  rotated by size (see below), so `logs/` stays bounded. A long-lived process
  settles at roughly 170 MB RSS after a few thousand large messages (it does
  not keep growing). Reloading the log at start is linear in its size.

## Deliverability and compliance

What Mailroom does on every message, from the CLI, the browser and scheduled
sends alike:

- **Unsubscribe headers.** `List-Unsubscribe: <mailto:...?subject=unsubscribe>`
  on the Reply-To address (else the From address). Set `UNSUBSCRIBE_URL` to
  an `https://` endpoint **you host** and Mailroom also sends the RFC 8058
  one-click pair (`List-Unsubscribe: <https://...>` plus
  `List-Unsubscribe-Post: List-Unsubscribe=One-Click`), with `{email}` replaced
  by the URL-encoded recipient. Without a URL there is no `-Post` header,
  because one-click is only valid with HTTPS.
- **Plain-text part.** Every message is `multipart/alternative`: the text part
  is generated from the rendered HTML (links keep their address, entities are
  decoded, `<style>`/`<script>` dropped).
- **Message-ID and Date.** Each message gets a unique
  `<uuid@your-from-domain>` Message-ID, written to `logs/sent.jsonl` as
  `messageId` so a bounce can be traced to a recipient, and an RFC 5322 Date.
- **Suppression list.** `data/suppressed.csv` (`email,reason,added`; a plain
  one-address-per-line file also works). It is checked before every message, so
  an address added during a run is skipped by the next send. It applies to
  campaigns, scheduled sends (at fire time) and `--test` / test sends; it is not
  a per-campaign setting. Skipped addresses are logged as `skipped` with
  `reason: "suppressed"` and counted in the preview, the confirmation dialog
  and the run summary.
- **Rate ceiling.** A rolling one-hour window across all runs, rebuilt from the
  send log, so a restart or a second run cannot reset it. When it is full the
  run waits (and says so) until the oldest send ages out; Ctrl+C or *Stop*
  ends the wait and the campaign resumes later. Two Mailroom processes cannot
  send from the same log at the same moment (see *How it behaves*), so the
  window is never counted twice.

Add addresses to the suppression list:

```bash
npm run send -- --suppress "gone@example.com, other@example.com"

curl -X POST http://127.0.0.1:4173/api/suppress \
  -H 'content-type: application/json' \
  -d '{"emails": ["gone@example.com"], "reason": "unsubscribe"}'   # reason is optional
curl http://127.0.0.1:4173/api/suppression                         # path, count, emails
```

(With `MAILROOM_PASSWORD` set, send the session cookie as for any other API
call.) Delete a line from the file to un-suppress an address.

| Variable | Default | Purpose |
| --- | --- | --- |
| `EMAIL_REPLY_TO` | unset | Reply-To header; also the default unsubscribe mailbox |
| `UNSUBSCRIBE_MAILTO` | Reply-To, else From | Mailbox that receives "unsubscribe" mail |
| `UNSUBSCRIBE_URL` | unset | `https://` one-click endpoint you host; `{email}` is replaced |
| `SUPPRESSION_FILE` | `data/suppressed.csv` | Suppression list location (CLI: `--suppression-file`) |
| `MAX_PER_HOUR` | `500` | Rolling messages-per-hour ceiling for all domains; `0` turns it off |
| `MAX_PER_DOMAIN_PER_HOUR` | `0` (off) | Same, per recipient domain (e.g. `gmail.com`); a full domain pauses the run |

A malformed value (`MAX_PER_HOUR=lots`, an `http://` `UNSUBSCRIBE_URL`, an
`EMAIL_FROM` without a domain) stops the send with a message before any mail goes out.

What stays with you, because it cannot be done from inside the app:

- **SPF, DKIM and DMARC** are DNS and provider settings. Gmail and Yahoo
  require them for bulk senders; with a hosted SMTP account the provider signs
  for you, so use a From address on a domain you have authenticated there.
- **Reading the unsubscribe mailbox.** Mailroom does not receive mail. When
  someone mails "unsubscribe" (or your one-click endpoint is hit), add them with
  `--suppress` or `/api/suppress`. The same goes for bounces and spam complaints.
- **The one-click endpoint** must be public HTTPS; the Mailroom UI is not
  (and should not be) exposed that way.
- **Keep spam complaints under 0.3 %** (Google's threshold), a postal address in
  the template footer where your jurisdiction requires it (CAN-SPAM), and only
  mail people who asked for it.

## How it behaves

- One campaign at a time; a second start is refused rather than double-mailing.
  That holds across processes: a run holds `logs/sent.jsonl.lock` (the log's
  path plus `.lock`, containing its pid) for as long as it sends, so the CLI
  and the browser, or two CLIs, cannot send from the same log together. A lock
  left by a process that is gone is taken over automatically; if a pid is
  reused by something unrelated, delete the lock file named in the message.
- 4 s between messages by default (and at most `MAX_PER_HOUR` per hour), one message in flight at a time over a
  pooled SMTP connection, retries with backoff on transient errors.
- Quota, `5.4.5` and authentication errors reported for the account (sign-in,
  sender or message stage) stop the run so the mailbox is not locked; a refusal
  of one recipient (an over-quota or disabled mailbox, an unknown user) only
  fails that recipient. 10 connection failures in a row stop the run too.
- **Unconfirmed sends.** The SMTP socket timeout is 120 s. If the connection
  drops or times out after the message body was sent and before the server
  replied, the server may have accepted it, so Mailroom does not retry it: the
  address is logged as `uncertain`, shown as *unconfirmed* in the run summary
  (CLI exit code 1), and skipped on every resume of that campaign. Check your
  Sent folder, then mail it again with a new campaign name if it never went
  out.
- `Ctrl+C` (SIGINT) or SIGTERM during a campaign, in the CLI and in the
  browser server alike, finishes and logs the message in flight, starts no
  more, prints how many recipients were not attempted and how to resume, and
  exits non-zero (130 for SIGINT, 143 for SIGTERM). An idle server exits 0. A
  second signal exits immediately; the message in flight may then be
  unrecorded, so check the log before re-running. The server waits up to 8 s
  for the message in flight, so keep your supervisor's stop timeout above that
  (Docker's default 10 s is enough).
- A scheduled send interrupted by a shutdown goes back to `pending` and
  resumes on the next start, skipping whoever was already mailed, as long as it
  is inside the grace window (otherwise it is parked as `missed` and **Run
  now** resumes it). An entry left `sending` by a crash gets the same
  treatment at startup. Pressing Stop on a running scheduled send marks it
  `cancelled`.
- Every outcome is appended to `logs/sent.jsonl`; that log is the resume state.
  If it cannot be written the run stops rather than mail people it cannot record.
- **Log rotation**: when `sent.jsonl` reaches `SEND_LOG_MAX_BYTES` it is renamed
  to `sent.jsonl.1` (older archives shift to `.2`, `.3`, ...) and the oldest
  beyond `SEND_LOG_KEEP` is deleted. Resume and the campaign list read the live
  file and every archive, so nothing is lost until an archive is deleted; a send
  older than the kept history is no longer skipped on a re-run, so raise
  `SEND_LOG_KEEP` if you resume very old campaigns. `schedule.json` is bounded
  separately (finished entries are dropped after 60 days).
- A subject line is not HTML: `&` and apostrophes reach the recipient as typed,
  while the body is escaped so a name cannot break the markup.

## Files

```
bin/mailroom.mjs        launcher (port, host, browser)
scripts/                dev tooling (check-syntax.mjs, used by npm run check)
src/gui.mjs             HTTP/HTTPS server + JSON/SSE API
src/send.mjs            command-line front end
src/lib/core.mjs        CSV, render, text part, cid: images, SMTP, suppression, rate ceiling, send loop
src/lib/config.mjs      settings file (read/write, 0600)
src/lib/mailer.mjs      SMTP rules (TLS, From, app-password cleanup), unsubscribe/Message-ID headers
public/                 the browser UI
templates/              HTML templates + their image folders
data/                   recipient CSVs, suppressed.csv (data/recipients.example.csv tracked)
logs/                   send log (sent.jsonl) and schedule queue (schedule.json)
test/                   node:test suite (npm test)
```

Settings resolve in this order: `MAILROOM_CONFIG` → a `./.env` beside the app →
`~/.mailroom/config.env`. Real environment variables always win, so Docker can
override the file.

Supported SMTP environment variables:
`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER` (or `GMAIL_USER`), `SMTP_PASS` (or `GMAIL_PASS`), `EMAIL_FROM` (or `SMTP_FROM`), `SMTP_SECURE`, `SMTP_ALLOW_SELF_SIGNED`. Compliance variables are listed under
[Deliverability and compliance](#deliverability-and-compliance).

## Security notes

- Binds to `127.0.0.1` by default. A non-loopback bind requires
  `MAILROOM_PASSWORD` along with either `MAILROOM_TLS_CERT` + `MAILROOM_TLS_KEY`
  or an explicit `MAILROOM_ALLOW_INSECURE=1` for a trusted TLS proxy; otherwise
  startup is refused before the port opens.
- The GUI password is never compared in plaintext: it is checked as a salted
  scrypt hash (`MAILROOM_PASSWORD_HASH`, or `MAILROOM_PASSWORD` hashed in memory)
  with a constant-time comparison, and login attempts are throttled per client.
- The session cookie is `HttpOnly`, `SameSite=Strict` and `Secure` whenever the
  browser connected over HTTPS (Mailroom's own TLS, or a trusted proxy with
  `MAILROOM_TRUST_PROXY=1`); on loopback HTTP it omits `Secure` so local use
  still works. Sessions expire after `MAILROOM_SESSION_TTL_SECONDS`, logging out
  destroys the session on the server, and logging in again retires the old one.
- Every response sends a Content-Security-Policy (scripts and connections only
  from Mailroom itself, no framing, no plugins), `X-Frame-Options`,
  `Referrer-Policy: no-referrer`, cross-origin isolation headers and, over
  HTTPS, HSTS. The message preview is a sandboxed frame with no script access.
- Requests must carry a loopback `Host` header (or one configured in
  `GUI_ALLOWED_HOSTS`), which stops DNS-rebinding pages from driving the server.
- A request whose `Origin` is not the page's own host is refused, and so is any
  state-changing request the browser labels `Sec-Fetch-Site: cross-site` or
  `same-site`, so another website cannot POST a send here and spend the stored
  SMTP credentials.
- `data/` is ignored by git in full (except `data/recipients.example.csv`):
  pasted lists and saved CSVs are personal data and should never be committed.
- Only files inside `data/` and `templates/` can be selected.
- The settings file is written atomically with mode `0600`; passwords are never
  returned by the API.
- Sessions are in-memory: restarting the server signs everyone out.

## Tests

```bash
npm test            # 142 tests: parsing, rendering, resume, retries, scheduling, shutdown, log rotation, config validation, suppression, headers, rate ceiling, CLI, API, auth, TLS, guards
npm run check       # parse every JS file in bin/, src/ and public/ without running it
```

GitHub Actions (`.github/workflows/tests.yml`) runs `npm ci`, `npm run check`
and `npm test` on Node 20, 22 and 24 for every push to `main` and every pull
request.

The API tests boot the real server against an in-process SMTP sink, so no mail
leaves the machine.

## Limitations

- Delivery is via SMTP submission: your provider's daily caps and reputation
  apply, and "sent" means the server accepted it, not that it reached an inbox.
- Bounces arrive at the From mailbox; Mailroom does not process them.
- Scheduled sends need the process to be alive at the due time; there is no
  external cron or queue worker. Start it under `systemd`, Docker restart
  policy, or `launchd` if the timing matters.
- Mailroom sends the unsubscribe headers and honours a suppression list, but it
  does not receive unsubscribe requests, bounces or complaints; you feed them
  in (see above). For large, regulated, or marketing lists use a real ESP.
- Templates are HTML files on disk, not a visual editor.
