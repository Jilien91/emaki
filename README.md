# Kaishi SRS

A lightweight spaced-repetition trainer for the Kaishi 1.5k Japanese vocab deck. Static HTML/CSS/JS, no build step, no backend. Progress is saved to `localStorage`.

## Structure

- `index.html`, `style.css`, `app.js`: the app
- `data/vocab.json`: the full 1500-word deck (generated, don't hand-edit)
- `data/kanji.json`: component breakdowns for the kanji the deck uses
- `raw/kaishi_1500_full.json`: source deck of word, reading, meaning, sentence, frequency
- `raw/kaishi_batchN_with_mnemonics.json`: mnemonics + usage notes, 25 words per batch
- `scripts/merge.pl`: merges `raw/*_with_mnemonics.json` batches into `data/vocab.json`
- `MNEMONICS.md`: the style guide to paste into whatever writes the next batch

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
   is served from to **Redirect URLs**, e.g. `https://<user>.github.io/kaishi-srs/`
   and `http://localhost:8123` for local work. The magic link only returns to
   URLs listed here.

The project URL and publishable key in `sync.js` are meant to be public: they
identify the project, they don't grant access. The RLS policies in step 1 are
what keep one account's rows private, so sync is only safe once that SQL has
run.

Sync is best-effort: the app keeps working offline and signed out, local edits
are flagged and pushed when a connection returns, and on load the device with
unpushed changes wins. Studying offline on two devices at once can still lose
one side's changes. It's last-write-wins, not a merge.
