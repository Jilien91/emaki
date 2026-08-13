# Auth setup runbook

Everything the app needs from the Supabase dashboard, in the order it matters.
Step 1 is a launch blocker. Step 2 is optional and can wait.

Your project ref is the subdomain in `SUPABASE_URL` at the top of
[`../sync.js`](../sync.js): `uozdxhcyxwnyqrplwokr`.

Every step here involves a secret, so nobody but you should be typing them. The
commands below are written so the secret comes out of your shell, never out of a
file or a chat log. Set the variables in a terminal you then close.

---

## 1. Custom SMTP (do this before anyone else uses the app)

The built-in sender is capped at **two emails an hour** and Supabase describes it
as best-effort and not for production. Magic-link sign-in is unusable in public
without this. OAuth sends no email and is unaffected.

### Resend, start to finish

1. **resend.com**, sign up (GitHub or Google is fine).
2. **Domains → Add Domain**. Use a subdomain, `auth.emakisrs.com`, not the bare
   domain. Resend recommend it so sending reputation is isolated from the root,
   and it means a future newsletter cannot poison sign-in delivery. Pick the
   region closest to you.
3. Resend shows a handful of DNS records. Add each one in
   **Cloudflare → Websites → emakisrs.com → DNS → Records**.

   **The Cloudflare trap:** it appends the zone to whatever you type in Name. If
   Resend says the name is `resend._domainkey.auth.emakisrs.com`, type
   `resend._domainkey.auth` and nothing more, or you end up with
   `...emakisrs.com.emakisrs.com` and verification never passes. There is no
   proxy toggle on TXT and MX records, so nothing to grey out here.

4. Back in Resend, **Verify**. Usually a minute or two.
5. **API Keys → Create API Key**. Sending access is enough. Copy it now, it is
   shown once.
6. Supabase → **Authentication → SMTP Settings**, enable custom SMTP:

   | Field | Value |
   |---|---|
   | Host | `smtp.resend.com` |
   | Port | `587` |
   | Username | `resend` |
   | Password | the Resend API key |
   | Sender email | `noreply@auth.emakisrs.com` |
   | Sender name | `Emaki` |

   The sender address has to be on the domain you verified, so it is the
   subdomain, not `noreply@emakisrs.com`.

7. Supabase → **Authentication → Rate Limits**. Custom SMTP starts at 30 emails
   an hour, and **leave it there**. Resend's free tier is 3,000 a month and 100
   a day, so 30 an hour is not what limits you: sustained, it would be 720 a day,
   seven times more than Resend will send. Raising it buys no capacity and only
   means somebody hammering the sign-in form with junk addresses burns the daily
   allowance faster and does more damage to your sending reputation first. Raise
   it if real users ever hit it, which would be a good problem to have.
8. Test: sign out, request a link, then request a second one a minute later.
   **Both arriving is the proof.** One arriving proves nothing, because the
   built-in sender allows two an hour and would also deliver the first.

### Via the dashboard, in general

1. Supabase → your project → **Authentication** → **SMTP Settings**
2. Turn on **Enable Custom SMTP**
3. Fill in host, port (587 for STARTTLS), username, password, sender email and
   sender name. The sender address must be on the domain you verified.
4. Save, then **Authentication → Rate Limits** and raise the email limit. Custom
   SMTP starts at 30 an hour.
5. Test it: sign out in the app, request a link, confirm it arrives.

### Or via the Management API

Create a personal access token at
<https://supabase.com/dashboard/account/tokens> first.

```bash
read -rs SUPABASE_PAT   && echo
read -rs SMTP_PASSWORD  && echo
curl -X PATCH "https://api.supabase.com/v1/projects/uozdxhcyxwnyqrplwokr/config/auth" \
  -H "Authorization: Bearer $SUPABASE_PAT" \
  -H "Content-Type: application/json" \
  -d "{
    \"smtp_host\": \"smtp.resend.com\",
    \"smtp_port\": \"587\",
    \"smtp_user\": \"resend\",
    \"smtp_pass\": \"$SMTP_PASSWORD\",
    \"smtp_admin_email\": \"noreply@your-domain.example\",
    \"smtp_sender_name\": \"Emaki\"
  }"
```

`read -rs` keeps both secrets off screen and out of shell history. Change the
host, user and sender to match whichever provider you chose.

---

## 2. OAuth providers (optional)

Until these are enabled, the Google and GitHub buttons return an error instead
of redirecting. If you are not doing this yet, delete the entries you are not
enabling from `OAUTH_PROVIDERS` at the top of [`../sync.js`](../sync.js) and the
buttons go with them. An app with one working sign-in beats one with three
buttons where two fail.

The callback URL, for both providers:

```
https://uozdxhcyxwnyqrplwokr.supabase.co/auth/v1/callback
```

On the Supabase side everything below happens under
**Authentication → Sign In / Providers**, in the CONFIGURATION part of the
sidebar. Not **OAuth Apps** under MANAGE, which sounds right and is the opposite
thing: that one is for letting other applications authenticate against your
project.

### Google

Google replaced the old "APIs & Services → OAuth consent screen" with the
**Google Auth Platform** console. There is no "User type" field any more; the
Internal/External choice is now a step called Audience inside the setup wizard.
Any guide still telling you to look for User type is out of date.

1. Google Cloud Console → create or pick a project
2. **Google Auth Platform → Overview → Get started**, then four screens:
   - **App Information**: app name `Emaki`, and your address as user support email
   - **Audience**: choose **External**
   - **Contact Information**: your address
   - **Finish**: agree to the User Data Policy, then Create
3. **Clients → Create client → Web application**, and put the callback URL above
   under **Authorised redirect URIs**. Copy the client ID and secret from the
   panel that appears.
4. **Audience → Test users → Add users**, and add every address you will test
   with
5. Paste the client ID and secret into Supabase →
   **Authentication → Sign In / Providers → Google**, and enable it

Until Google verifies the app, anyone not on that test user list gets an
"unverified app" warning. Verification lives under **Verification centre** and
takes days to weeks, so start it well before launch or expect that screen.

### GitHub

1. GitHub → Settings → Developer settings → **OAuth Apps → New OAuth App**
2. Authorization callback URL: the callback URL above
3. Generate a client secret
4. Copy the client ID and secret into Supabase →
   **Authentication → Sign In / Providers → GitHub**, and enable it

GitHub has no review process, so it works immediately. If you only want one
provider to start with, make it this one.

---

## 3. Redirect URLs (already done, worth re-checking)

Supabase → **Authentication → URL Configuration → Redirect URLs** must list
every origin the app is served from. Both magic link and OAuth return through
this list, so a missing entry fails after the user has already authenticated,
which is the confusing kind of broken.

**Mind the trailing slash.** Supabase matches these as patterns, not as exact
strings, and `.` and `/` count as separators. `http://localhost:8123` does not
match `http://localhost:8123/`, and the app sends the second one, because
`signInWithProvider` passes `window.location.href` and a bare origin always
arrives with its slash. Add these four:

```
http://localhost:8123/
http://localhost:8123/**
https://emakisrs.com/
https://emakisrs.com/**
```

The `/**` entries catch anything with a query string on the end. Supabase
suggests keeping production tight to the exact path, so drop the wildcards once
you know nothing needs them.

---

## Checking it worked

- Sign-in with a provider redirects out and comes back signed in, and the badge
  reads Synced
- A magic link arrives in under a minute, and a second request a minute later
  also arrives, which is what proves you are off the built-in sender
- Sign in on a second device and yesterday's reviews are already there
- Supabase → Authentication → Users shows one row per person, not one per device
