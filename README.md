# Kaishi SRS

A lightweight spaced-repetition trainer for the Kaishi 1.5k Japanese vocab deck. Static HTML/CSS/JS, no build step, no backend — progress is saved to `localStorage`.

## Structure

- `index.html`, `style.css`, `app.js` — the app
- `data/vocab.json` — the full 1500-word deck (generated, don't hand-edit)
- `raw/kaishi_1500_full.json` — source deck: word, reading, meaning, sentence, frequency
- `raw/kaishi_batch1_with_mnemonics.json` — mnemonics + usage notes for words 1-100
- `scripts/merge.pl` — merges `raw/*_with_mnemonics.json` batches into `data/vocab.json`

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

It's a static site — push this folder to GitHub Pages, Netlify, Vercel, or any static host as-is.
