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
   (1-90, no repeats), with a running history. Tapping **Generate number** is
   what actually draws it - see "Two roles" below for who does that.
3. **Track prizes.** Early Five, Top Line, Middle Line, Bottom Line, and Full
   House are detected automatically and announced with confetti and a sound
   cue as soon as any ticket satisfies them, on the admin's screen.
4. **Two roles.** The **admin** runs everything: tickets, scanning, the host
   controls, and watches the board and prizes. **Players** just open the
   link - no account needed - and get one thing: a **Generate number**
   button that draws the next number for everyone (the admin's screen, and
   every other player's history, update live). Players see nothing else: no
   board, no prizes, no tickets, no host controls. See "Roles and the
   backend" below.

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

## Roles and the backend (Supabase)

| | Admin | Player (anyone with the link) |
| --- | --- | --- |
| Generate the next number | no | **yes** |
| Caller ball and history | yes | yes |
| Prizes, board | yes | **no** |
| Tickets and their numbers | yes | **no** |
| Host controls, armed prizes | yes | **no** |
| Scan tickets, undo, start, new game | yes | no |
| How they get in | signs in with email and password | opens the link, nothing to sign in |

The game is stored in a Supabase project, and the **database itself** enforces
the table above (row level security), so it holds even though the project URL
and publishable key in `js/config.js` are public:

- `game_public`: status, numbers called, prize winners. Anyone can read it
  (everyone watches live over Supabase Realtime). The admin can change it
  directly (undo, start, new game); drawing the *next* number instead goes
  through `call_next_number()`, a database function anyone can call (no
  sign-in) that reads tickets/rigs internally but never returns them.
- `game_admin`: tickets, armed prizes, settings. Only an admin can read or
  change it directly. It is not published to the live channel, and
  `call_next_number()` is the only thing besides the admin that ever reads it.
- `profiles`: each signed-in user's role. Nobody can change a role through the
  API, not even an admin; you promote the admin once with the SQL below.

Players never receive tickets or the armed prize - they don't even see the
board or who won, only the numbers as they draw them. The code in this
repository is public, so the *feature* is visible to anyone who reads it; the
*configuration* (which ticket is armed) is not.

### One-time setup

1. **Run the SQL.** Supabase dashboard -> SQL Editor -> New query -> paste all
   of `supabase/migrations/20261004000000_roles_and_game_state.sql` -> Run,
   then do the same with `20261004170000_player_call_next_number.sql` (this
   one is what lets a player's tap actually draw the next number). Both are
   safe to run again.
2. **Create your admin account.** Dashboard -> Authentication -> Users -> Add
   user -> Create new user, enter your email and a password, tick **Auto
   Confirm User**.
3. **Make it the admin.** In the SQL Editor run this once, with your email:

   ```sql
   update public.profiles
      set role = 'admin'
    where id = (select id from auth.users where lower(email) = lower('YOUR_EMAIL_HERE'));
   ```

4. **Recommended settings** (Authentication): set the Site URL to your
   Cloudflare address. Players don't need accounts, so you can switch off new
   sign-ups once your admin exists (then "Create player account" in the app
   will say sign-ups are disabled, which is fine).
5. Redeploy on Cloudflare (a push does it). No new Cloudflare variables are
   needed: the project URL and publishable key are in `js/config.js`.

Then open the site, tap **Admin sign in**, and you get the full app. Send
players the plain link.

### How it behaves

- The admin's game is saved as it changes, so reloading the admin page resumes
  the game (tickets, armed prizes, numbers called).
- The header shows **Players in sync** (admin) or **Live** (players). If the
  connection drops the admin can keep playing: the badge changes to **Players
  not in sync, retrying**, and the latest state is sent when it is back.
- There is one game at a time. **New game** clears the shared state and sends
  players back to "Waiting for the host".
- If two people sign in as admin at once the last write wins, so use one.

### If it isn't working

| What you see | Likely cause |
| --- | --- |
| Players stuck on **Reconnecting...** | Supabase project paused (free projects pause after about a week of no use: restore it in the dashboard), wrong URL/key in `js/config.js`, or the SQL was never run |
| Admin gets "The server refused the update" | The account isn't an admin yet (step 3), or the game rows are missing (step 1) |
| "permission denied" or "relation does not exist" | The SQL wasn't run in this project |
| Admin sign-in says wrong email or password | Account not created, or not confirmed (tick Auto Confirm User) |
| Scanning says "Sign in as admin" | You are viewing as a guest or player |

Supabase's MCP server for this project is configured in `.mcp.json`. To use
it from Claude Code, run `claude /mcp` in a regular terminal and authenticate
the `supabase` server once.

## AI ticket scanning

Only the admin can scan: the browser sends a downscaled copy of the ticket photo, together with the admin's sign-in token, to `/api/scan`, a
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
js/game.js         Prize rules, the decoy-then-forced rig engine, admin-side restore/undo
js/backend.js      Supabase: sign in, role, public/admin game state, live updates, call_next_number
js/config.js       Public Supabase URL and publishable key (no secrets here)
js/vendor/supabase.js  Local copy of supabase-js (MIT), no CDN
supabase/migrations/   The SQL that creates roles, tables, security rules, and call_next_number()
.mcp.json          Supabase MCP server config for Claude Code
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
- `/api/scan` only works for a signed-in admin (the function asks Supabase
  whether the caller's token belongs to an admin before using any AI quota).
- Players need an internet connection to generate numbers; there is one game
  at a time. Multiple players tapping Generate at once is fine (the database
  serializes it, no duplicate or skipped numbers), but a player tapping at the
  exact moment the admin hits Undo is last-write-wins, same as two
  simultaneous admins would overwrite each other.
