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
  mailroom
```

Set `MAILROOM_PASSWORD` whenever the port is reachable by anyone else — the
password gate is what stops a stranger from sending through your mailbox.

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
| `MAILROOM_TLS_CERT` | unset | Path to a PEM certificate (chain included if needed) |
| `MAILROOM_TLS_KEY` | unset | Path to the matching PEM private key |
| `MAILROOM_ALLOW_INSECURE` | unset | Set to `1` to permit a non-loopback plain-HTTP bind |

Set both TLS variables together; Mailroom refuses to start if only one is
present or if either file cannot be read. When TLS is active the session cookie
is marked `Secure`, so it is never sent over a plain-HTTP connection.

A non-loopback host over plain HTTP is refused at startup unless
`MAILROOM_ALLOW_INSECURE=1` is set. Use that opt-out only when a trusted reverse
proxy terminates TLS on the same private network; if you need the `Secure`
cookie flag, let Mailroom terminate TLS itself. `--host` and `GUI_HOST` keep
working exactly as before — they are just checked against this rule.

Upgrading: an existing Docker or LAN install that ran plain HTTP on
`0.0.0.0` must now add the TLS pair or `MAILROOM_ALLOW_INSECURE=1`. Startup
fails with a message naming both options rather than silently serving
credentials in the clear.

## What it does

**Compose** — every `templates/*.html` file is offered as a template. A folder
next to it (`newsletter-assets/`) is picked up automatically and its images
attached inline with `cid:` (Gmail blocks `data:` URIs).

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
  --csv data/recipients.csv \
  --html templates/newsletter.html \
  --assets-dir templates/newsletter-assets \
  --subject "Chamber News | November" \
  --campaign newsletter-nov-2026 \
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
- **Keep messages small.** Inline images travel with every message; the bundled
  template is ~1 MB per recipient, so 5 000 recipients is ~5 GB of upload. Cut
  image weight (or host them) before a big run.
- **A broken link stops the run.** After 10 consecutive connection-level
  failures (network down, IP blocked, provider refusing) Mailroom stops instead
  of burning three retries per address down the list; the rest stay unsent and
  the campaign is resumable.
- **Resume is per campaign.** Re-running `campaign-x` skips everyone already
  logged as sent for `campaign-x`, so use a new campaign name for a new
  newsletter. The default name is the current month, which is right for a
  monthly send and wrong for two different mails in the same month.
- **Disk and memory**: the send log grows by ~100 bytes per recipient, and a
  long-lived process settles at roughly 170 MB RSS after a few thousand large
  messages (it does not keep growing). Reloading the log at start is linear in
  its size, so a multi-hundred-thousand-line log adds a moment to startup.

## How it behaves

- One campaign at a time; a second start is refused rather than double-mailing.
- 4 s between messages by default, one message in flight at a time over a
  pooled SMTP connection, retries with backoff on transient errors.
- Quota, `5.4.5` and authentication errors stop the run so the mailbox is not
  locked, and 10 connection failures in a row stop it too.
- `Ctrl+C` finishes and logs the message in flight, then exits.
- Every outcome is appended to `logs/sent.jsonl`; that log is the resume state.
- A subject line is not HTML: `&` and apostrophes reach the recipient as typed,
  while the body is escaped so a name cannot break the markup.

## Files

```
bin/mailroom.mjs        launcher (port, host, browser)
src/gui.mjs             HTTP/HTTPS server + JSON/SSE API
src/send.mjs            command-line front end
src/lib/core.mjs        CSV, render, cid: images, SMTP, send loop
src/lib/config.mjs      settings file (read/write, 0600)
src/lib/mailer.mjs      SMTP rules (TLS, From, app-password cleanup)
public/                 the browser UI
templates/              HTML templates + their image folders
data/                   recipient CSVs
logs/                   send log
test/                   node:test suite (npm test)
```

Settings resolve in this order: `MAILROOM_CONFIG` → a `./.env` beside the app →
`~/.mailroom/config.env`. Real environment variables always win, so Docker can
override the file.

## Security notes

- Binds to `127.0.0.1` by default. A non-loopback bind requires
  `MAILROOM_TLS_CERT` + `MAILROOM_TLS_KEY`, or an explicit
  `MAILROOM_ALLOW_INSECURE=1` for a trusted TLS proxy; plain HTTP elsewhere is
  refused before the port opens.
- With TLS active the session cookie is `HttpOnly`, `SameSite=Strict` and
  `Secure`; on loopback HTTP it omits `Secure` so local use still works.
- Requests must carry a loopback `Host` header, which stops DNS-rebinding pages
  from driving the server.
- A request carrying a foreign `Origin` is refused, so another website cannot
  POST a send here and spend the stored SMTP credentials.
- `data/` is ignored by git in full: pasted lists and saved CSVs are personal
  data and should never be committed.
- Only files inside `data/` and `templates/` can be selected.
- The settings file is written atomically with mode `0600`; passwords are never
  returned by the API.
- Sessions are in-memory: restarting the server signs everyone out.

## Tests

```bash
npm test     # 36 tests: parsing, rendering, resume, retries, scheduling, API, auth, TLS, guards
```

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
