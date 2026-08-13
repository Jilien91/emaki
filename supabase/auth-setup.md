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

Pick a provider first. Resend and Postmark both have free tiers big enough here,
and both want a verified sending domain, which is the slow part. Do that first
and the rest is five minutes.

### Via the dashboard

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
5. Paste the client ID and secret into Supabase → **Authentication → Providers →
   Google**, and enable it

Until Google verifies the app, anyone not on that test user list gets an
"unverified app" warning. Verification lives under **Verification centre** and
takes days to weeks, so start it well before launch or expect that screen.

### GitHub

1. GitHub → Settings → Developer settings → **OAuth Apps → New OAuth App**
2. Authorization callback URL: the callback URL above
3. Generate a client secret
4. Copy the client ID and secret into Supabase → **Authentication → Providers →
   GitHub**, and enable it

GitHub has no review process, so it works immediately. If you only want one
provider to start with, make it this one.

---

## 3. Redirect URLs (already done, worth re-checking)

Supabase → **Authentication → URL Configuration → Redirect URLs** must list
every origin the app is served from. Both magic link and OAuth return through
this list, so a missing entry fails after the user has already authenticated,
which is the confusing kind of broken.

```
http://localhost:8123
https://<user>.github.io/emaki/
```

---

## Checking it worked

- Sign-in with a provider redirects out and comes back signed in, and the badge
  reads Synced
- A magic link arrives in under a minute, and a second request a minute later
  also arrives, which is what proves you are off the built-in sender
- Sign in on a second device and yesterday's reviews are already there
- Supabase → Authentication → Users shows one row per person, not one per device
