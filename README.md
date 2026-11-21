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
  -e MAILROOM_PASSWORD='a-long-passphrase' \
  -e MAILROOM_TLS_CERT=/certs/fullchain.pem \
  -e MAILROOM_TLS_KEY=/certs/privkey.pem \
  -p 4173:4173 \
  -v "$PWD/certs:/certs:ro" \
  -v mailroom-config:/root/.mailroom \
  -v "$PWD/data:/app/data" \
  -v "$PWD/templates:/app/templates" \
  -v "$PWD/logs:/app/logs" \
  mailroom
```

The container binds `0.0.0.0`, so it needs the TLS pair (or the opt-out
described below) as well as `MAILROOM_PASSWORD`. With the command above the app
is at `https://localhost:4173`.

If TLS ends at a reverse proxy, keep the container on a private network and
allow plain HTTP only for that hop:

```bash
docker run -d --name mailroom \
  -e MAILROOM_PASSWORD='a-long-passphrase' \
  -e MAILROOM_ALLOW_INSECURE=1 \
  -p 127.0.0.1:4173:4173 \
  -v mailroom-config:/root/.mailroom \
  -v "$PWD/data:/app/data" \
  -v "$PWD/templates:/app/templates" \
  -v "$PWD/logs:/app/logs" \
  mailroom
```

`MAILROOM_PASSWORD` is required for any non-loopback bind, including every
Docker setup above: Mailroom refuses to start without it, even with
`MAILROOM_ALLOW_INSECURE=1`.

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
| `MAILROOM_PASSWORD` | unset | Passphrase required for non-loopback binds to gate the GUI |
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

Set both TLS variables together; Mailroom refuses to start if only one is
present or if either file cannot be read. When TLS is active the session cookie
is marked `Secure`, so it is never sent over a plain-HTTP connection.

A non-loopback host over plain HTTP is refused at startup unless
`MAILROOM_ALLOW_INSECURE=1` is set. Use that opt-out only when a trusted reverse
proxy terminates TLS on the same private network; if you need the `Secure`
cookie flag, let Mailroom terminate TLS itself. `--host` and `GUI_HOST` keep
working exactly as before — they are just checked against this rule.

Upgrading: an existing Docker or LAN install that ran plain HTTP on
`0.0.0.0` must now add the TLS pair or `MAILROOM_ALLOW_INSECURE=1`, and must set
`MAILROOM_PASSWORD`. Startup fails with a message naming the missing setting
rather than silently serving credentials in the clear or an open relay.

## What it does

**Compose** — every `templates/*.html` file is offered as a template. A folder
next to it named `<template>-assets/` (for example, `bcci-connect-v2-assets/`) is
picked up automatically and its images attached inline with `cid:` (Gmail blocks
`data:` URIs). Bundled templates include `bcci-connect-v2.html`,
`bcci-connect.html`, and `bcci-membership.html`.

**Recipients** — either a saved `data/*.csv`, or paste addresses straight in:

```
priya@example.com, Priya Shah, Sunrise Chemicals
Raj Patel <raj@patel.in>
ops@example.com	Ops Desk	Example Co
```

Invalid and duplicate lines are dropped as you type, and **Save as CSV** writes
the list into `data/` for next time.

**Preview** — the actual rendered HTML for the selected recipient, images
included, with arrows to page through the list.

**Send** — a confirmation gate, then per-recipient progress over a live stream.
Re-running a campaign skips everyone it already mailed. Close the tab and the
send continues; reopen it and the page re-attaches.

**Schedule** — **Schedule…** queues the same campaign for a later date and time
(in your machine's time zone). The queue lives in `logs/schedule.json`, so it
survives restarts; **Scheduled** in the header shows what is waiting, with
*Send now* and *Cancel* on each entry. The recipient list is snapshotted at the
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
sending, `--limit 100` caps the run, `--delay 4000` sets the gap. Scheduling is
driven from the browser, where the queue and its history can be seen.

## Sending a lot of mail

- **Gap between messages is 4 s** on the CLI, the browser and the API alike — a
  request that omits `delay` gets 4 s, not an unthrottled burst. `delay: 0` is
  honoured when you deliberately want the fastest run your provider allows.
- **Throughput is tamed by design**: one message at a time, one campaign at a
  time. Measured against a local SMTP sink with this repo's template, a 500
  recipient run takes about 9 s, i.e. ~55 messages/s with no gap and ~900/hour at
  the default 4 s gap. Your provider's rate limits, not Mailroom, set the real
  ceiling.
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

## How it behaves

- One campaign at a time; a second start is refused rather than double-mailing.
- 4 s between messages by default, one message in flight at a time over a
  pooled SMTP connection, retries with backoff on transient errors.
- Quota, `5.4.5` and authentication errors stop the run so the mailbox is not
  locked, and 10 connection failures in a row stop it too.
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
src/lib/core.mjs        CSV, render, cid: images, SMTP, send loop
src/lib/config.mjs      settings file (read/write, 0600)
src/lib/mailer.mjs      SMTP rules (TLS, From, app-password cleanup)
public/                 the browser UI
templates/              HTML templates + their image folders
data/                   recipient CSVs (data/recipients.example.csv tracked)
logs/                   send log (sent.jsonl) and schedule queue (schedule.json)
test/                   node:test suite (npm test)
```

Settings resolve in this order: `MAILROOM_CONFIG` → a `./.env` beside the app →
`~/.mailroom/config.env`. Real environment variables always win, so Docker can
override the file.

Supported SMTP environment variables:
`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER` (or `GMAIL_USER`), `SMTP_PASS` (or `GMAIL_PASS`), `EMAIL_FROM` (or `SMTP_FROM`), `SMTP_SECURE`, `SMTP_ALLOW_SELF_SIGNED`.

## Security notes

- Binds to `127.0.0.1` by default. A non-loopback bind requires
  `MAILROOM_PASSWORD` along with either `MAILROOM_TLS_CERT` + `MAILROOM_TLS_KEY`
  or an explicit `MAILROOM_ALLOW_INSECURE=1` for a trusted TLS proxy; otherwise
  startup is refused before the port opens.
- With TLS active the session cookie is `HttpOnly`, `SameSite=Strict` and
  `Secure`; on loopback HTTP it omits `Secure` so local use still works.
- Requests must carry a loopback `Host` header (or one configured in
  `GUI_ALLOWED_HOSTS`), which stops DNS-rebinding pages from driving the server.
- A request carrying a foreign `Origin` is refused, so another website cannot
  POST a send here and spend the stored SMTP credentials.
- `data/` is ignored by git in full (except `data/recipients.example.csv`):
  pasted lists and saved CSVs are personal data and should never be committed.
- Only files inside `data/` and `templates/` can be selected.
- The settings file is written atomically with mode `0600`; passwords are never
  returned by the API.
- Sessions are in-memory: restarting the server signs everyone out.

## Tests

```bash
npm test            # 77 tests: parsing, rendering, resume, retries, scheduling, shutdown, log rotation, config validation, CLI, API, auth, TLS, guards
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
- Plain SMTP submission gives no unsubscribe handling — use a real ESP for
  large, regulated, or marketing lists.
- Templates are HTML files on disk, not a visual editor.
