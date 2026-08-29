# Emaki

Written mnemonics for the [Kaishi 1.5k](https://github.com/donkuri/Kaishi)
Japanese vocab deck, with a spaced-repetition trainer around them.

> **Emaki is not affiliated with, or endorsed by, Kaishi 1.5k or its authors.**
> The word list is theirs and is used with their kind permission
> ([donkuri/Kaishi#158](https://github.com/donkuri/Kaishi/issues/158)). The
> mnemonics, the kanji breakdowns and this app are not their work, so anything
> wrong with those is a matter for this repository and not for theirs.

Static HTML/CSS/JS, no build step, no backend. Progress is saved to
`localStorage`.

An emaki is a painted handscroll that tells a story one scene at a time as you
unroll it, which is what the cards here are: one image per word rather than a
stated link between a sound and a meaning.

## Structure

- `index.html`, `style.css`, `app.js`: the app
- `data/vocab.json`: the full 1500-word deck (generated, don't hand-edit)
- `data/kanji.json`: component breakdowns for the kanji the deck uses
- `raw/kaishi_1500_full.json`: source deck of word, reading, meaning, sentence, frequency
- `raw/kaishi_batchN_with_mnemonics.json`: mnemonics + usage notes, 25 words per batch
- `scripts/merge.pl`: merges `raw/*_with_mnemonics.json` batches into `data/vocab.json`
- `audio/f/<id>.mp3`, `audio/m/<id>.mp3` + `data/audio.json`: generated word audio, optional (see below)

Only words with a mnemonic show up in Lessons. To add another batch of mnemonics (e.g. words 101-200), drop a `raw/kaishi_batchN_with_mnemonics.json` file (same shape as batch1, matched by word+reading+meaning) and rerun:

```
perl scripts/merge.pl
```

`scripts/batch-prep.pl` works out what the next batch needs. It runs in two
stages because a batch is written in two passes, kanji entries first and
mnemonics second:

```
perl scripts/batch-prep.pl          # the next 50 words, the data/kanji.json
                                    # entries they need, and every collision
perl scripts/batch-prep.pl --kanji  # after the kanji pass: the reference to
                                    # write the mnemonics against
```

Stage one works the next free batch number out numerically and refuses to carry
on if that file already exists, because reading it off a directory listing
sorts `batch10` before `batch2` and that is how an existing batch once got
overwritten. It reports two kinds of collision: the ones `verify.pl` enforces
(shared readings, one written form with two cards) and the softer ones nothing
enforces, near-identical readings and overlapping meanings, which are where the
usage notes come from.

Stage one also lists the kanji to add. Finish those before writing a single
mnemonic, then run stage two, which prints components for everything but
withholds the notes of entries added in the current pass. Those are the ones a
mnemonic tends to quote back, having been written minutes earlier, and the card
then says twice what the breakdown above it already said.

`scripts/check-notes.pl` compares the usage notes here against the upstream
deck's own Notes field, which it carries on 56 of its 1,500 cards:

```
perl scripts/check-notes.pl
```

That field is not in `raw/kaishi_1500_full.json`, so it is invisible from
inside this repository, and ten early notes turned out to have been copied or
lightly reworded from it before anyone compared the two. Run it before shipping
a batch. It needs an Anki export of the deck saved in the project root as
`Kaishi*.txt`, which is gitignored and must stay that way, since it carries the
audio, images and pitch accent this project does not ship. Without one the
script says so and exits clean.

## Word audio (optional)

The app speaks a word by playing its mp3 from `audio/`, falling back to the
device's own Japanese voice for anything not covered. Neither is required: with
no audio generated and no voice installed, the speaker buttons simply don't
appear and nothing else changes.

Shipping the files is worth it because the device voices are a lottery. On
Windows the locally installed one is old and flat, the good neural voices are
network voices, and telling somebody to install a language pack before they can
study is a bad first experience. Generated audio sounds the same everywhere and
asks nothing of the user.

The files are generated and committed, so this is already done: 1,500 words in
each of two voices. You only need the rest of this section to regenerate them,
after a correction to a reading or a change of voice.

`scripts/gen-audio.pl` builds them with Azure's Japanese voices, one female and
one male, into `audio/f/` and `audio/m/`. Learners pick between them in
Settings. It reads `AZURE_SPEECH_KEY` and `AZURE_SPEECH_REGION` from the
environment, never from a file, so no key ends up in the repository:

```
export AZURE_SPEECH_KEY=...
export AZURE_SPEECH_REGION=francecentral
perl scripts/gen-audio.pl --set hd --limit 20   # hear them before making 3000 files
perl scripts/gen-audio.pl --set hd              # the rest
perl scripts/gen-audio.pl --only f              # one voice
```

**Check the region stocks the voices before anything else.** This is the trap
worth knowing about: HD voices exist in only nine regions, and a resource
anywhere else answers `400` with an empty body, which tells you nothing. Ask the
region directly:

```
curl -H "Ocp-Apim-Subscription-Key: $AZURE_SPEECH_KEY" \
  https://$AZURE_SPEECH_REGION.tts.speech.microsoft.com/cognitiveservices/voices/list
```

`uksouth` returns 556 voices and zero Dragon ones. `francecentral` returns 728
including both used here. The others with HD are `westeurope`, `swedencentral`,
`eastus`, `eastus2`, `westus2`, `canadacentral`, `centralindia` and
`southeastasia`.

Two voice sets, chosen with `--set`:

- `standard` (the default): `ja-JP-NanamiNeural` and `ja-JP-KeitaNeural`.
  Available in every TTS region, and supports more SSML than HD, `<prosody>`
  included.
- `hd`: `ja-JP-Nanami:DragonHDLatestNeural` and `ja-JP-Masaru:DragonHDLatestNeural`.
  Better, and what ships. Needs one of the nine regions above.

Standard is the default because it works everywhere. Note the shipped files were
made with `--set hd`, so a plain rerun with `--force` would replace them with
standard voices.

It speaks the reading rather than the characters, the same rule the app uses, so
the synthesiser is never left to guess which reading a card teaches. Cards
already generated are skipped, so an interrupted run costs nothing to restart,
and `--force` regenerates, which is what you want after changing a voice. It
writes `data/audio.json` by scanning what is actually on disk, so a partly
generated deck produces a correct manifest and the remaining words fall back.

`DragonHD` rather than `Dragon HD Omni` is a constraint, not a preference:
DragonHD accepts `<phoneme>` and Omni does not, so an Omni voice would silently
disable the pronunciation overrides below. All HD voices reject `<prosody>`
entirely, which is why speaking speed is applied in the browser rather than
baked into the files.

### Pitch accent

Isolated words are where text to speech is weakest on Japanese: with no
sentence around it, the model has only its own accent dictionary to go on. For
common vocabulary, which is what this deck is, it is usually right, and both HD
voices are generated with `enhancePronunciation` on, which asks the model to
work harder on ambiguous words.

Where it still gets one wrong, `data/pronunciation.json` overrides that card:

```json
{ "8": "ジ'ン" }
```

Keyed by card id, in Azure's `ja-JP` `sapi` phone set, which is katakana with
`'` immediately before the mora carrying the accent nucleus. The generator then
wraps that card in `<phoneme>` instead of sending plain kana.

This is deliberately a list of corrections rather than a full accent layer.
Azure documents the notation with three examples and no rules, so annotating
1500 words on faith could easily make more of them wrong than it fixes. Add an
entry after hearing a word come out wrong, then regenerate that card with
`--force`.

The whole deck is 4,902 characters of Japanese per voice, so both together are
under 10,000 against a 500,000/month free tier. The generated set is 14 MB of
mp3 across 3,000 files, median 4.6 KB each. A full two-voice run takes about
forty minutes and is resumable.

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
   It creates the `user_state` table and the row-level security policies. Safe
   to re-run, and it needs re-running after any change to it: the delete policy
   was added later, and without it Settings → Delete my data reports success
   and removes nothing, because RLS denies by default and PostgREST cannot tell
   "no rows matched" from "not allowed". The app checks the row is really gone
   and says so if it isn't.
2. In Supabase → Authentication → URL Configuration, add every origin the app
   is served from to **Redirect URLs**, e.g. `https://emakisrs.com/` and
   `http://localhost:8123/` for local work. Both the magic link and the OAuth
   round trip only return to URLs listed here, and the trailing slash is part of
   the match, so leaving it off silently breaks sign-in after the user has
   already authenticated. See [`supabase/auth-setup.md`](supabase/auth-setup.md).
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

Sync is best-effort: the app keeps working offline and signed out, and local
edits are reconciled when a connection returns.

It is a merge, not last-write-wins. Each device remembers the state it and the
server last agreed on, so a sync can tell which side changed a field rather than
having to pick a winner: reviews and lessons from both devices are kept, counts
add up instead of one replacing the other, and only a field both sides moved
needs a rule. The write is then conditional on the row's `revision`, so two
devices reconciling at the same moment cannot have the second silently replace
the first; it reads and merges again instead.

It used to be last-write-wins, and on 27 August 2026 that cost a morning of
study. A laptop holding the previous day marked itself as having local changes
purely by noticing the date had turned over, and the rule of the time was that
a device with local changes pushed its whole copy without ever reading the
server's. The rules now in `sync.js` are written against that sequence, and
`scripts/sync-merge-test.js` replays it in both directions:

```
node scripts/sync-merge-test.js
```

There is a second suite, and it is the one to run before touching `sync.js`:

```
node scripts/sync-reconcile-test.js
```

It drives the real `reconcile()` against a fake Supabase client that can be
interfered with mid-request, and a "tab" in it is a whole separate copy of
`sync.js` in its own context sharing one `localStorage`. Every sync bug that has
actually cost anything here has been about *when* things happen rather than what
the merge rules say — an edit made while a write was in flight, two tabs sharing
a dirty mark but not their memory, a write the server committed and the client
never heard about. None of that is visible to a test that calls the merge
functions directly.

Anyone upgrading from before that date needs to re-run `supabase/schema.sql` for
the `revision` column. Without it the merge still runs, which is the part that
stops work being lost; only the conditional write is skipped.

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

**The word audio**, if `audio/` is present, is none of Kaishi's. It is
synthesised by [`scripts/gen-audio.pl`](scripts/gen-audio.pl) from the reading
field using Azure's neural voices, whose terms allow generated speech to be
shipped inside an application. It is a machine reading of a word, not a
recording, and it is not the AJT Japanese audio that the deck itself carries —
that is still deliberately absent, and the fact that this repository now has an
`audio/` directory does not change it.

> **Status.** Kaishi carries no licence of its own, but its author has given
> permission for the word list to be used here, in
> [donkuri/Kaishi#158](https://github.com/donkuri/Kaishi/issues/158), on the
> conditions that the lack of affiliation or endorsement is stated clearly at
> the first mention of Kaishi and that the deck is linked. Both are done, above
> and in the app itself.
>
> That permission covers this project and does not travel. Treat the deck layer
> as all rights reserved: it is not covered by either licence above, and it is
> not yours to take from this repository. Ask them yourself, as we did.

This project is not affiliated with, or endorsed by, Kaishi 1.5k.
