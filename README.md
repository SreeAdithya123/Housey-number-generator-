# Housey - Tambola/Housie Caller

A free, installable web app for running a Housie (Tambola) night with friends:
scan each player's paper ticket with your phone camera, then run the number
caller from the same phone. No accounts and no build step - it's a static
site (plus one small optional Cloudflare Function for AI scanning) that you
can install to a home screen like a native app.

## What it does

1. **Scan tickets.** Upload or photograph each player's ticket. A vision AI
   model reads the 15 printed numbers into a digital 3x9 grid (see "AI ticket
   scanning" below). Any box that breaks the rules of a Housie ticket (wrong
   column, repeated number, a row without 5 numbers) is highlighted in amber.
   If the AI is unavailable you get an empty grid and the reason, and type the
   numbers in. Always check the grid against the paper ticket before saving.
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
sometimes throttled. A throttled request is retried a few times with short
pauses, and the second model is tried each time. If everything still fails,
the app says why and leaves an empty grid to type into. There is no
on-device OCR fallback: it was measured at 1 of 15 numbers on a real ticket
photo, and a plausible-looking wrong read is worse than an empty grid.

### Checking that it is wired up

The upload card shows a status line as soon as the page loads:

| Status line | Meaning | Fix |
| --- | --- | --- |
| AI scanner is ready. | Function deployed and it can see the key | nothing |
| deployed but has no API key | Function is live, secret missing for this environment | add `OPENROUTER_API_KEY` (Production, and Preview if you test on preview URLs), then redeploy |
| isn't available on this host (no /api/scan) | The host has no Functions (for example GitHub Pages), or the deploy skipped `functions/` | use the Cloudflare Pages URL; check the build log says it compiled Functions |
| Couldn't reach the AI scanner | You are offline | reconnect |

You can also open `https://<your-site>/api/scan` in a browser. It returns
`{"ok":true,"configured":true,...}` when everything is in place and never
shows the key.

### Local development

Static pages alone can't run the function. Use Wrangler, with the key in a
git-ignored `.dev.vars` file:

```bash
echo 'OPENROUTER_API_KEY=your-key-here' > .dev.vars
npx wrangler pages dev .
```

## Running it

Without AI scanning, any static file server works (tickets then have to be
typed in by hand):

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
`/api/scan`, so tickets there have to be typed in.

The service worker is network-first, so a new deployment is picked up on the
next load; the cache only answers when the network is slow or gone. A phone
that still has an older version installed may need two or three reloads (or
"Clear & reset" in the browser's site settings) the first time.

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
js/ocr.js          Ticket photo -> 3x9 grid via /api/scan, plus the status check
js/ticket-rules.js Housie ticket rules: place numbers by column, flag misreads
functions/api/scan.js  Cloudflare Function: calls OpenRouter, holds the API key
js/game.js         Draw pool, prize rules, the decoy-then-forced rig engine
js/ui.js           DOM helpers: editable/readonly grids, toast, confetti, sound
js/app.js          Wires everything together, screen/event handling
manifest.json      PWA metadata (name, icons, standalone display)
sw.js              Service worker: network-first, cached copy when offline or slow
icons/             App icons (plus the source .svg files used to generate them)
```

## Known limitations

- Scan accuracy depends on photo quality (flat, well-lit, in focus, one ticket
  filling the frame). AI reads are not guaranteed, and the free OpenRouter models can be
  throttled at busy times. Always check the scanned grid before saving a ticket.
- `/api/scan` is open to anyone who can reach the site and spends your
  OpenRouter quota. It only accepts same-site requests and small images, which
  stops casual abuse but is not real authentication.
- This is a single-device/single-browser experience: ticket and draw state
  live only in memory for that page session, and resets if you reload. There
  is no multi-device sync - "Presentation Mode" is meant to be viewed on a
  second screen mirrored or cast from the host's device, not a separate
  live connection.
