# lamapoll-mailer (Node.js / TypeScript)

Sends an automatic confirmation e-mail for every new LamaPoll signup. LamaPoll has no webhooks, so the
service polls the `legacyResults` export, queues new submissions in SQLite and sends them over your SMTP server.

**Everything is configured in the admin UI.** The only thing you type is the LamaPoll API key; then you pick
the poll (form) from a list and the e-mail field (and optional first/last name) from the poll's questions.
Mail text, SMTP, sending rules, pause/resume and queue management are in the UI too.

One submission = one mail. The same address signing up twice gets two mails (capped by "Mails pro Adresse und Stunde").

## Run it
Requires Node.js 24+ (runs the TypeScript sources directly, no build step).
```sh
npm install --omit=dev
HOST=127.0.0.1 PORT=3000 DATA_DIR=./data npm start
```
On the first start the log prints a **Setup-Code**. Open the address, enter the code and choose the admin password.
Then follow the pages: *Einstellungen* (1 LamaPoll, 2 SMTP, 3 sending rules), *Mail-Text*, then *Übersicht → Starten*.

The only environment variables are `HOST` (default `127.0.0.1`), `PORT` (default `3000`) and `DATA_DIR` (default `./data`).
The SQLite file in `DATA_DIR` holds the API key and SMTP password (file mode 600, directory mode 700): back it up nightly, keep it private.

## Production (Linux VPS)
```sh
sudo useradd --system --home /var/lib/lamapoll-mailer lamapoll-mailer
sudo mkdir -p /opt/lamapoll-mailer && sudo cp -r src package.json package-lock.json /opt/lamapoll-mailer/
cd /opt/lamapoll-mailer && sudo npm install --omit=dev
sudo cp deploy/lamapoll-mailer.service /etc/systemd/system/ && sudo systemctl enable --now lamapoll-mailer
journalctl -u lamapoll-mailer | grep Setup-Code
```
### Docker (alternative)
```sh
docker build -t lamapoll-mailer .
docker run -d --name lamapoll-mailer --restart unless-stopped \
  -p 127.0.0.1:3000:3000 -v lamapoll-mailer-data:/data lamapoll-mailer
docker logs lamapoll-mailer | grep Setup-Code
```
Inside the container `HOST=0.0.0.0` and `DATA_DIR=/data`. Publish the port only on `127.0.0.1` and keep the proxy in
front. The volume holds the secrets, so back it up.

Put Caddy in front for HTTPS (`deploy/Caddyfile`) and allow only ports 22, 80 and 443. Behind a proxy the session cookie
automatically gets the `Secure` flag (via `X-Forwarded-Proto`). Set SPF, DKIM and DMARC for the sender domain: that matters
more for deliverability than anything in this code.

## Mail template
HTML with placeholders: `{name}` `{first_name}` `{last_name}` `{email}` `{site_url}` `{answers}` (table of all answers,
decoded to readable labels) and `{field:V60}` (one answer by variable name). The editor has preview (sandboxed), a warning for
unknown placeholders such as the `{signup_type}` in the old PHP template, and "Test-Mail senden".

## How it behaves
- **First start:** signups that already exist when you click *Starten* are not mailed (your choice in the UI).
- **Polling:** every 20 s (configurable) with a date-only `dateFrom` one day back, like the PHP script; known submissions
  are ignored by their `vID`. Failed polls back off up to 5 minutes and show up in the dashboard.
- **Restart safe:** a row is marked `sending` before the SMTP call. If the server dies mid-send, that row is *not*
  resent automatically; the dashboard flags it and you choose "Bestätigen" (it was delivered) or "Erneut".
- **Security:** setup code on first start, scrypt password hashes, `HttpOnly` + `SameSite=Strict` session cookie,
  cross-site POSTs refused, HTML-escaped output, sandboxed template preview.

## Development
```sh
npm test            # node:test, no network needed
npm run typecheck   # tsc --noEmit
```
See `AGENTS.md` for the workflow rules.
