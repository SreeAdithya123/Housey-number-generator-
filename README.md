# Housey - Tambola/Housie Caller

A free, installable web app for running a Housie (Tambola) night with friends:
scan each player's paper ticket with your phone camera, then run the number
caller from the same phone. No server, no accounts, no build step - it's a
static site you can open directly or install to a home screen like a native
app.

## What it does

1. **Scan tickets.** Upload or photograph each player's ticket. The app runs
   on-device OCR (a vendored copy of Tesseract.js, bundled locally rather
   than loaded from a CDN - see "Vendored OCR engine" below) to read the 15
   printed numbers into a digital 3x9 grid, which you can tap to correct
   before saving - OCR on a phone photo is never perfect, so always glance
   over the grid before saving.
2. **Call numbers.** A big caller ball shows each number as it's drawn
   (1-90, no repeats), with a running history, a 1-90 board, and live
   highlighting of every ticket's matched numbers.
3. **Track prizes.** Early Five, Top Line, Middle Line, Bottom Line, and Full
   House are detected automatically and announced with confetti and a sound
   cue as soon as any ticket satisfies them.
4. **Presentation mode.** Switch the shared screen (a TV, or a second phone
   everyone can see) into Presentation Mode, which hides all host-only
   controls. The host keeps running the draw from their own device in Host
   Controls mode.

## The "fixed winner" feature - read this before using it

The host panel lets you **arm** a prize (e.g. Early Five) to a specific
ticket. When armed:

- The first *N* numbers drawn (default 2, adjustable) are always genuinely
  random - nothing is rigged yet.
- After that, the app starts feeding in numbers from the chosen ticket, in
  random order, until that ticket satisfies the armed prize, then announces
  the win normally.
- If a different ticket legitimately completes a prize first (including
  during the decoy draws), it wins fairly - the rig never overrides a prize
  that's already been won.

This exists as a party trick for free games among friends (e.g. surprising
someone on their birthday), where no one is paying for tickets or playing
for a cash prize. **Do not use this for a game involving money, entry fees,
or real prizes** - secretly fixing who wins a game other people are paying
into is deceiving them out of money, not a game feature. If you're running a
stakes game, just don't arm any rig; the caller plays a completely fair,
unmodified random draw on its own.

## Running it

It's a static site - any static file server works:

```bash
npx serve .
# or
python3 -m http.server 8080
```

Then open the printed URL. Opening `index.html` directly via `file://` also
mostly works, except the service worker (used for install/offline support)
needs `http://` or `https://`.

### Deploying

Push this repo to GitHub and enable GitHub Pages (Settings -> Pages ->
deploy from the `main` branch, root folder). No build step is required.
Any other static host (Netlify, Vercel, Cloudflare Pages, a plain S3
bucket) works the same way - just point it at this folder.

### Installing it like a mobile app

Once it's served over `https://` (GitHub Pages works great for this):

- **Android (Chrome):** open the site, tap the "Install app" button in the
  header (or the browser's own "Install app" / "Add to Home screen" menu
  item). It launches full-screen with its own icon, no browser bar.
- **iPhone (Safari):** open the site, tap the Share icon, then "Add to Home
  Screen". iOS doesn't allow apps to trigger this automatically, which is
  why the in-app "Add to Home Screen" button just shows you those steps.

## Project structure

```
index.html        Markup for both screens (ticket setup + game)
css/styles.css     All styling (mobile-first, dark theme)
js/ocr.js          Ticket photo -> 3x9 number grid (Tesseract.js)
js/game.js         Draw pool, prize rules, the decoy-then-forced rig engine
js/ui.js           DOM helpers: editable/readonly grids, toast, confetti, sound
js/app.js          Wires everything together, screen/event handling
js/vendor/tesseract/  Vendored OCR engine (see below) - not hand-edited
manifest.json      PWA metadata (name, icons, standalone display)
sw.js              Service worker: caches the app shell for fast/offline loads
icons/             App icons (plus the source .svg files used to generate them)
```

## Vendored OCR engine

`js/vendor/tesseract/` holds a local copy of everything Tesseract.js needs:
the library itself, its web worker, a WASM OCR core (three variants, so the
browser's own feature detection can pick the fastest one it supports), and
the English trained-data file. These are copied as-is from the `tesseract.js`,
`tesseract.js-core`, and `@tesseract.js-data/eng` npm packages (all
Apache-2.0/MIT licensed) - vendored rather than loaded from a CDN at
runtime, so ticket scanning keeps working even with a restrictive network
policy or no network at all after the first load, and the app never depends
on a third-party CDN's uptime. The large files here (a few WASM cores plus
the trained-data file, around 15 MB total) are only fetched by the browser
the first time someone actually scans a ticket, then cached by the service
worker for every scan after that.

To update these files later (e.g. a new Tesseract.js release):

```bash
npm install tesseract.js tesseract.js-core @tesseract.js-data/eng --prefix /tmp/tess-update
cp /tmp/tess-update/node_modules/tesseract.js/dist/{tesseract.min.js,worker.min.js} js/vendor/tesseract/
cp /tmp/tess-update/node_modules/tesseract.js-core/tesseract-core-*lstm.wasm.js js/vendor/tesseract/core/
cp /tmp/tess-update/node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz js/vendor/tesseract/lang-data/
```

## Known limitations

- OCR accuracy depends entirely on photo quality (flat, well-lit, in focus).
  Always check the scanned grid before saving a ticket.
- This is a single-device/single-browser experience: ticket and draw state
  live only in memory for that page session, and resets if you reload. There
  is no multi-device sync - "Presentation Mode" is meant to be viewed on a
  second screen mirrored or cast from the host's device, not a separate
  live connection.
