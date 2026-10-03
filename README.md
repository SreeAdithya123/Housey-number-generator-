# Housey - Tambola/Housie Caller

A free, installable web app for running a Housie (Tambola) night with friends:
scan each player's paper ticket with your phone camera, then run the number
caller from the same phone. No accounts and no build step - it's a static
site (plus one small optional Cloudflare Function for AI scanning) that you
can install to a home screen like a native app.

## What it does

1. **Scan tickets.** Upload or photograph each player's ticket. A vision AI
   model reads the 15 printed numbers into a digital 3x9 grid (see "AI ticket
   scanning" below). If the AI is unavailable the app falls back to basic
   offline OCR. Either way the grid is editable, and any box that breaks the
   rules of a Housie ticket (wrong column, repeated number, a row without 5
   numbers) is highlighted in amber. Always glance over the grid against the
   paper ticket before saving.
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

## AI ticket scanning

The browser sends a downscaled copy of the ticket photo to `/api/scan`, a
Cloudflare Pages Function (`functions/api/scan.js`). The function asks a
vision model on [OpenRouter](https://openrouter.ai) to list the numbers in
each row, then the app places every number in the column its value belongs to
(1-9 in column 1, 10-19 in column 2 ... 80-90 in column 9). That keeps the
layout correct even if the model gets the blank cells wrong.

**The API key never goes in this repo or in the browser code.** It lives only
as a Cloudflare secret, so visitors to the site can't read it.

### Setup (Cloudflare Pages)

1. Create a key at <https://openrouter.ai/settings/keys>.
2. In Cloudflare: Workers & Pages -> your project -> Settings -> Variables and
   Secrets -> add a **Secret** named `OPENROUTER_API_KEY` (for Production, and
   Preview if you use previews). If the dashboard says variables are managed
   by `wrangler.toml`, set it from a terminal instead:
   `npx wrangler pages secret put OPENROUTER_API_KEY --project-name <your-project>`.
3. Redeploy (push a commit, or retry the latest deployment). Secrets only
   apply to deployments made after they are added.

Optional variable `OPENROUTER_MODELS`: comma-separated model ids tried in
order. The default is `google/gemma-4-31b-it:free,qwen/qwen3.8-27b:free`: the
second one is used automatically when the first is rate limited, errors, or
returns something unreadable. Any OpenRouter model that accepts images works.

Free models share a pool of capacity across all OpenRouter users, so they are
sometimes throttled. When every model fails, the app tells the host and falls
back to the offline OCR below, which is much less accurate.

### Local development

Static pages alone can't run the function. Use Wrangler, with the key in a
git-ignored `.dev.vars` file:

```bash
echo 'OPENROUTER_API_KEY=your-key-here' > .dev.vars
npx wrangler pages dev .
```

## Running it

Without AI scanning, any static file server works (the app then uses the
offline OCR fallback):

```bash
npx serve .
# or
python3 -m http.server 8080
```

Then open the printed URL. Opening `index.html` directly via `file://` also
mostly works, except the service worker (used for install/offline support)
needs `http://` or `https://`.

### Deploying

Deploy on **Cloudflare Pages** to get AI scanning: connect the repo, leave the
build output as the repo root (`wrangler.toml` sets it), and add the secret
described above. Static-only hosts such as GitHub Pages serve the app but not
`/api/scan`, so they use the offline OCR fallback.

**Whenever you change files the app loads** (anything under `js/`, `css/`,
`index.html`), bump `CACHE_VERSION` in `sw.js`. Installed copies of the app
serve cached files first and only pick up changes when that version changes.

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
js/ocr.js          Ticket photo -> 3x9 grid: AI via /api/scan, Tesseract fallback
js/ticket-rules.js Housie ticket rules: place numbers by column, flag misreads
functions/api/scan.js  Cloudflare Function: calls OpenRouter, holds the API key
js/game.js         Draw pool, prize rules, the decoy-then-forced rig engine
js/ui.js           DOM helpers: editable/readonly grids, toast, confetti, sound
js/app.js          Wires everything together, screen/event handling
js/vendor/tesseract/  Vendored OCR engine (see below) - not hand-edited
manifest.json      PWA metadata (name, icons, standalone display)
sw.js              Service worker: caches the app shell for fast/offline loads
icons/             App icons (plus the source .svg files used to generate them)
```

## Vendored OCR engine (offline fallback)

Used only when AI scanning is unavailable. `js/vendor/tesseract/` holds a
local copy of everything Tesseract.js needs:
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

- Scan accuracy depends on photo quality (flat, well-lit, in focus, one ticket
  filling the frame). AI reads are far better than the offline OCR but are
  not guaranteed, and the free OpenRouter models can be throttled at busy
  times. Always check the scanned grid before saving a ticket.
- `/api/scan` is open to anyone who can reach the site and spends your
  OpenRouter quota. It only accepts same-site requests and small images, which
  stops casual abuse but is not real authentication.
- This is a single-device/single-browser experience: ticket and draw state
  live only in memory for that page session, and resets if you reload. There
  is no multi-device sync - "Presentation Mode" is meant to be viewed on a
  second screen mirrored or cast from the host's device, not a separate
  live connection.
