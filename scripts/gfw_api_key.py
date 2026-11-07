#!/usr/bin/env python3
"""Create a Global Forest Watch Data API key for Terragent and save it to .env as GFW_API_KEY.

Run from anywhere:  python3 scripts/gfw_api_key.py

Prerequisite (a human, once): a GFW account. Sign up at https://www.globalforestwatch.org/
("My GFW" -> sign up), then set your password from the email GFW sends.

Your password is read without echo, sent only to data-api.globalforestwatch.org to get a
short-lived login token, and never stored or printed. The new key is written to .env (chmod 600)
and only its last 4 characters are shown. Keys are valid for one year.
"""
import getpass
import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

API = "https://data-api.globalforestwatch.org"
# GFW rate-limits keys by an allowlist of origins; requests must send a matching `origin` header.
# Server-side code should send `origin: localhost` (dev) or the deployed *.vercel.app host.
DOMAINS = ["localhost", "*.vercel.app"]
ENV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env")


def ssl_context():
    """python.org builds on macOS ship without system roots ("Install Certificates.command").
    Load certifi if present, else macOS's bundled /etc/ssl/cert.pem, so no setup step is needed."""
    ctx = ssl.create_default_context()
    try:
        import certifi  # type: ignore

        ctx.load_verify_locations(certifi.where())
    except ImportError:
        if os.path.exists("/etc/ssl/cert.pem"):
            ctx.load_verify_locations("/etc/ssl/cert.pem")
    return ctx


SSL_CTX = ssl_context()


def call(method, path, *, form=None, body=None, headers=None):
    data, hdrs = None, {"User-Agent": "Terragent/0.1 (hackathon build)", **(headers or {})}
    if form is not None:
        data = urllib.parse.urlencode(form).encode()
        hdrs["Content-Type"] = "application/x-www-form-urlencoded"
    elif body is not None:
        data = json.dumps(body).encode()
        hdrs["Content-Type"] = "application/json"
    req = urllib.request.Request(API + path, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30, context=SSL_CTX) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except ValueError:
            return e.code, {}


def find(obj, key):
    """Return the first value for `key` anywhere in a nested JSON object."""
    if isinstance(obj, dict):
        if key in obj:
            return obj[key]
        for v in obj.values():
            hit = find(v, key)
            if hit is not None:
                return hit
    elif isinstance(obj, list):
        for v in obj:
            hit = find(v, key)
            if hit is not None:
                return hit
    return None


def save_env(key):
    s = open(ENV_PATH).read() if os.path.exists(ENV_PATH) else ""
    line = f"GFW_API_KEY={key}"
    if re.search(r"^GFW_API_KEY=", s, re.M):
        s = re.sub(r"^GFW_API_KEY=.*$", line, s, flags=re.M)
    elif re.search(r"^# GFW_API_KEY=\s*$", s, re.M):
        s = re.sub(r"^# GFW_API_KEY=\s*$",
                   "# Global Forest Watch Data API (send header `origin: localhost` or the *.vercel.app host)\n" + line,
                   s, flags=re.M)
    else:
        s = s.rstrip("\n") + "\n" + line + "\n"
    old = os.umask(0o077)
    try:
        with open(ENV_PATH, "w") as f:
            f.write(s)
    finally:
        os.umask(old)
    os.chmod(ENV_PATH, 0o600)
    assert line in open(ENV_PATH).read(), "write verification failed"


def main():
    email = input("GFW account email: ").strip()
    password = getpass.getpass("GFW password (hidden): ")

    status, tok = call("POST", "/auth/token", form={"username": email, "password": password})
    del password
    token = find(tok, "access_token")
    if status != 200 or not token:
        sys.exit(f"Login failed (HTTP {status}): {tok.get('message') or tok.get('detail') or 'no token returned'}")

    status, res = call("POST", "/auth/apikey", headers={"Authorization": f"Bearer {token}"},
                       body={"alias": "terragent", "organization": "Terragent", "email": email, "domains": DOMAINS})
    key = find(res, "api_key")
    if status not in (200, 201) or not key:
        sys.exit(f"Key creation failed (HTTP {status}): {res.get('message') or res.get('detail') or res}")

    save_env(key)
    print(f"Saved GFW_API_KEY (…{key[-4:]}) to .env. Expires: {find(res, 'expires_on') or 'in one year'}")

    status, val = call("GET", f"/auth/apikey/{key}/validate", headers={"origin": "localhost"})
    print(f"Validation: HTTP {status} {json.dumps(val)[:200]}")


if __name__ == "__main__":
    main()
