# Direct local HTTPS

The owner approved direct HTTPS in the existing Album Haven launcher after
reviewing the proxy and domain alternatives in this task. One `python app.py`
process must serve the configured LAN address and port, create and reuse a local
certificate, and keep authentication and playback policies intact. No proxy,
second port, domain registration, certificate installation, or UI is required.

This is a deployment/startup integration, not a new account capability or a
Wave 2 product surface. Existing route permissions and client behavior apply.
Windows, macOS, and Android browsers are manual acceptance targets. Native
clients and TV are outside this change. Browser warnings remain; browsers or
device policies that disallow certificate exceptions are unsupported by this
temporary testing setup.

## Design

- Add `MUSIC_APP_TLS_MODE=local`; unset or `off` preserves existing HTTP and
  reverse-proxy deployments. Enable local mode in this owner's ignored `.env`.
- Use the HTTPS host in `ALBUM_HAVEN_PUBLIC_BASE_URL` for the certificate's SAN.
  Require the URL's effective port to match the launcher port. Fail clearly on
  invalid configuration, conflicting trusted-proxy configuration, or unusable
  certificate files; never silently downgrade to HTTP.
- Use cryptography to create an RSA-2048, SHA-256, self-signed server certificate
  valid for 90 days. Reuse it across restarts; regenerate on startup when fewer
  than seven days remain or the configured hostname changes.
- Store the private key and certificate together in one atomically replaced PEM
  under the existing app data directory's `tls` subdirectory. This is transport
  key material, not app-owned persistence. It is never served, logged, or
  committed. Use restrictive creation permissions; Windows inherits the private
  app-data directory ACL. Do not install a root certificate or alter trust stores.
- Pass the PEM to Uvicorn's built-in TLS support. Disable forwarded-header
  handling for this direct-listener mode so clients cannot spoof their scheme
  or source address. Use an IPv6 listener for an IPv6 URL and IPv4 otherwise.
  Preserve the import factory and reload behavior. Reject encrypted existing
  PEMs noninteractively instead of allowing OpenSSL to request a password.
- Keep secure cookies, origin checks, authorization, password-reset token
  validation, Postgres persistence, and the AudioWorklet player unchanged.
- Explain one normal startup command, browser exception, LAN firewall access,
  certificate renewal, and using the same canonical URL for all devices.

## Verification

Add focused tests for off/local mode, configuration rejection, SAN/key matching,
reuse and renewal, invalid storage, atomic-write failures, and the actual TLS
handshake. Exercise the launcher with TLS enabled and preserve existing launcher
tests with an explicit HTTP environment. Run auth and reset tests unchanged.
Then verify the production app's HTTPS login page and WSS/secure-context behavior
where accessible. Android/macOS certificate-exception and playback acceptance
must be performed by the owner on those devices. Do not claim those devices
tested from a Windows-only run.
