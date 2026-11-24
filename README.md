# Word Finder

A talking picture dictionary for young children. A big keyboard sits at the bottom of the
screen. As a child types, the matching words appear above it, and only letters that can come
next stay pressable (f, r, o, z leaves just "frozen"). Or they tap 🎤 and say the word.

Each word shows a picture, a child-friendly meaning, and the word in big letters, with buttons to:

- **Say it**: hear the word
- **Spell it**: hear each letter while it lights up, then the whole word (tap any letter to hear just that one)
- **Meaning**: hear the definition and an example sentence

On a word's page the keyboard switches to practice: the letters start pale and fill in as the
child types them, the next key to press glows, and finishing the word gets a "Well done!".

Plain static files with no build step. It installs as a PWA and works offline.

## Run locally

```bash
python3 -m http.server 8765
```

Then open http://localhost:8765. Voice search needs `localhost` or HTTPS.

## Publish on GitHub Pages

Push to GitHub, then go to **Settings → Pages → Deploy from a branch**, pick `main` and `/ (root)`.

## Adding words

Add an entry to `data/words.json`:

```json
{"word":"frozen","type":"adjective","emoji":"🧊",
 "definition":"Turned into ice, or gone very hard and stiff, because it got so cold.",
 "example":"The pond was frozen, so the ducks walked on it.",
 "forms":["freezing"], "imageQuery":"frozen icicles"}
```

- `type`: noun, verb, adjective, adverb, preposition, conjunction, pronoun, determiner, number or interjection (shown with a child-friendly label such as "a doing word")
- `forms`: other spellings that should find this word, like plurals and past tenses ("teeth" finds "tooth")
- `emoji`: shown when there's no picture
- `imageQuery`: search text for the picture, if the word alone would find the wrong thing
- `noImage: true`: never fetch a picture for this word (abstract words, feelings, people)

## Pictures

```bash
node scripts/fetch-images.mjs
```

This downloads a CC0, public-domain, CC BY or CC BY-SA picture for each word from
[Openverse](https://openverse.org), saves its attribution to `data/credits.json` (shown under
the picture and on the credits page), and writes `review.html`. **Check every picture in
`review.html` before publishing.** Search results aren't hand-picked. To replace one picture:

```bash
node scripts/fetch-images.mjs moon --pick=1
```

Use `--remove` to go back to the emoji. Use `--candidates` to download the top 8 results to `candidates/<word>/` first, so you can see which `--pick` number to use.

## Browser support

- **Voice search** uses the browser's speech recognition: Chrome/Edge (desktop and Android)
  and Safari (iOS/macOS). Firefox has none, so the app falls back to typing. Chrome sends audio
  to Google to recognise it, so voice search doesn't work offline.
- **Speaking** uses the device's built-in voices and works everywhere, offline too.
