# Emaki

Written mnemonics for the Kaishi 1.5k Japanese vocab deck, with a
spaced-repetition trainer around them. Static HTML/CSS/JS, no build step, no
backend. Progress is saved to `localStorage`.

An emaki is a painted handscroll that tells a story one scene at a time as you
unroll it, which is what the cards here are: one image per word rather than a
stated link between a sound and a meaning.

Not affiliated with, or endorsed by, Kaishi 1.5k.

## Structure

- `index.html`, `style.css`, `app.js`: the app
- `data/vocab.json`: the full 1500-word deck (generated, don't hand-edit)
- `data/kanji.json`: component breakdowns for the kanji the deck uses
- `raw/kaishi_1500_full.json`: source deck of word, reading, meaning, sentence, frequency
- `raw/kaishi_batchN_with_mnemonics.json`: mnemonics + usage notes, 25 words per batch
- `scripts/merge.pl`: merges `raw/*_with_mnemonics.json` batches into `data/vocab.json`

Only words with a mnemonic show up in Lessons. To add another batch of mnemonics (e.g. words 101-200), drop a `raw/kaishi_batchN_with_mnemonics.json` file (same shape as batch1, matched by word+reading+meaning) and rerun:

```
perl scripts/merge.pl
```

## Run locally

`fetch()` can't load `data/vocab.json` over `file://`, so serve the folder over HTTP:

```
npx serve .
```

or

```
python -m http.server 8000
```

Then open the printed localhost URL.

## Deploy

It's a static site. Push this folder to GitHub Pages, Netlify, Vercel, or any static host as-is.

## Cross-device sync (optional)

Progress lives in `localStorage` by default, which is per-browser. Signing in
(Settings → Sync) mirrors it to Supabase so it follows you between devices.

Setup, once per Supabase project:

1. Run [`supabase/schema.sql`](supabase/schema.sql) in the Supabase SQL editor.
   It creates the `user_state` table and the row-level security policies.
2. In Supabase → Authentication → URL Configuration, add every origin the app
   is served from to **Redirect URLs**, e.g. `https://<user>.github.io/emaki/`
   and `http://localhost:8123/` for local work. Both the magic link and the
   OAuth round trip only return to URLs listed here, and the trailing slash is
   part of the match, so leaving it off silently breaks sign-in after the user
   has already authenticated. See [`supabase/auth-setup.md`](supabase/auth-setup.md).
3. Custom SMTP and the OAuth providers, both of which need secrets pasted into
   dashboards. Step by step in
   [`supabase/auth-setup.md`](supabase/auth-setup.md).

   The one not to skip: the built-in email sender is capped at **two messages an
   hour** and Supabase describes it as best-effort and not for production. Two
   sign-in links an hour is not a public app, so custom SMTP is a launch
   blocker rather than a nicety. OAuth sends no email and is unaffected, so
   Google or GitHub sign-in is a way to open up before the SMTP is sorted.

The project URL and publishable key in `sync.js` are meant to be public: they
identify the project, they don't grant access. The RLS policies in step 1 are
what keep one account's rows private, so sync is only safe once that SQL has
run.

Sync is best-effort: the app keeps working offline and signed out, local edits
are flagged and pushed when a connection returns, and on load the device with
unpushed changes wins. Studying offline on two devices at once can still lose
one side's changes. It's last-write-wins, not a merge.

## Licensing

Three layers, three answers. Please don't treat any one of them as covering the
others.

**The app** (`index.html`, `style.css`, `app.js`, `sync.js`, `scripts/`,
`supabase/`) is MIT. See [LICENSE](LICENSE). Take it and do what you like.

**The written content** is CC BY-SA 4.0: every mnemonic and usage note, all of
[`data/kanji.json`](data/kanji.json) and the `raw/*_with_mnemonics.json` batch
files. This is original work, written from scratch for this deck. Reuse it,
including commercially, as long as you credit it and keep it under the same
licence.

**The deck data** is not ours to license. The 1,500 words, readings, meanings
and example sentences in [`raw/kaishi_1500_full.json`](raw/kaishi_1500_full.json),
and the corresponding fields of `data/vocab.json`, come from
[Kaishi 1.5k](https://github.com/donkuri/Kaishi) by 栗 (donkuri) and
contributors, whose own sources are credited in their README. Only the six text
fields are used here: word, reading, meaning, sentence, sentence meaning and
frequency. The Kaishi audio (from AJT Japanese) and images (from irasutoya) are
deliberately not included.

> **Status, and it is worth being plain about it.** Kaishi carries no licence,
> so there is no permission to rely on and none has been granted here. Its
> authors are being asked. Until they answer, treat that layer as all rights
> reserved: it is not covered by either licence above, and it is not yours to
> take from this repository. If they would rather it were not here it comes out
> the same day, and the app will load a `.apkg` you import yourself instead.

This project is not affiliated with, or endorsed by, Kaishi 1.5k.
