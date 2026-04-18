# 🏸 Carnage Courts

A zero-signup badminton tournament engine for your Saturday open. Randomize teams, run a round-robin, log scores, crown the champion. Runs in the browser with a tiny Upstash Redis as the canonical store.

- **No accounts.** Identify yourself with a name once per device; that's your login.
- **Mobile-first.** Built for sweaty fingers on phone screens.
- **Realtime.** State syncs across every device in the room via Server-Sent Events (≤1s latency on typical networks).
- **$0 to host.** Static site on GitHub Pages + Upstash Redis free tier (10K commands/day, way more than enough for a weekend tournament).

---

## How it works

1. One person opens the app, identifies themselves with a name, then **creates a tournament** by picking a date from a calendar and a 2-digit admin PIN. The room ID is auto-generated as `sat18apr-xx` (day + date + month + 2-char suffix).
2. They share the URL — short form: `https://ktundwal.github.io/bt/?r=sat18apr-xx`.
3. Players open the link, enter their name (once per device), and they're auto-signed-up. Using the same name on another device claims the existing slot — no duplicates.
4. Admin hits **Randomize Teams** — pairs shuffled, given ridiculous names, round-robin schedule generated across the chosen number of courts.
5. As games finish, **anyone** can log the score — the leaderboard updates live on every phone.

### Landing page

Going to the root URL (`https://ktundwal.github.io/bt/`) shows all tournaments this device has ever touched:

- **Happening Now / Upcoming**: today's and future tournaments. Tap to sign up / play.
- **Previous**: past tournaments. Tap to view standings.
- **+ New Tournament**: create one via the date picker.
- **📋 Paste share link**: join by URL or room ID.
- **🗑**: delete. Propagates to every other device in the room via the shared store.

### Scoring rules
- First to 21, **win by 1** (21–20 valid; 22–21 valid; 22–20 not).
- Standings sorted by: wins → point differential (PF − PA) → points for.

### Who can do what
| Action              | Needs PIN? |
| ------------------- | ---------- |
| Join room, view     | No         |
| Add yourself        | No         |
| Log / clear a score | **No** — anyone playing can log their match |
| Remove a player (after teams set) | Yes |
| Randomize teams     | Yes        |
| Change court count (after teams set) | Yes |
| Reset / delete tournament | Yes  |

The PIN gates structural changes — who's playing, how many courts. Scoring is deliberately open because the creator is usually on court, not next to the scoreboard.

The PIN is stored only as a SHA-256 hash in the shared state. Cached on the admin's device in `localStorage`.

---

## Architecture

- **State store**: one Upstash Redis key per tournament (`cc:room:<roomId>`) holds the full JSON state.
- **Change propagation**: every mutation does `SET` + `PUBLISH` to `cc:chan:<roomId>`. Every open client subscribes via Server-Sent Events and re-fetches the key on any event.
- **localStorage cache**: each device keeps a copy so the app loads instantly and survives brief network hiccups; the cloud is the source of truth on reconnect.
- **No peer-to-peer**: an earlier version used WebRTC via Trystero but was replaced with Upstash because "no peer online" is a real scenario and P2P tombstones don't survive closed browsers.

Total Upstash spend for a 3-hour tournament with 20 devices: ≈ 300 commands. Free tier is 10K/day.

---

## Run locally

No build step. Paste your Upstash creds into `config.js` (or leave empty for offline-only), then:

```bash
python3 -m http.server 8080
# then open http://localhost:8080
```

---

## Deploy to GitHub Pages ($0)

1. Sign up at [upstash.com](https://upstash.com), create a free Redis database, grab the **REST URL** and **Read/Write Token**.
2. In your fork's repo, add two secrets (**Settings → Secrets and variables → Actions → New repository secret**):
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
3. **Settings → Pages**: set source to **GitHub Actions**.
4. Push to `main`. The workflow runs tests, injects the secrets into `config.js` at deploy time, and publishes to Pages. Live at `https://<you>.github.io/<repo>/` in ~60 seconds.

The shipped `config.js` contains only the real credentials in the deployed artifact — never committed to git.

### Honest security note
A static site can't hide a secret — whatever ships to the browser is extractable. The Upstash token in the deployed app is functionally public. The free-tier rate limit (10K commands/day) caps any abuse; rotate the token in Upstash's dashboard if needed. The blast radius is limited: this DB only stores tournament state, and even that is scoped to room IDs only your friends know.

### Alternate hosts (also free)
- **Cloudflare Pages**: connect the repo, output dir `/`. Replicate the config injection step.
- **Netlify / Vercel**: same idea — inject `config.js` from environment variables.

---

## Project layout

```
index.html                    # Markup, Tailwind config inline
styles.css                    # Custom styles on top of Tailwind
app.js                        # State, mutations, rendering
config.js                     # Placeholder creds; real values injected at deploy time
lib/cloudsync.mjs             # Upstash Redis REST + SSE wrapper
lib/scheduler.mjs             # Round-robin, seeded RNG, team-name generator
lib/scoring.mjs               # Score validation (first-to-21, win-by-1)
tests/                        # node:test unit tests
scripts/check-html.mjs        # Static sanity check for data-role refs
.github/workflows/ci.yml      # Test + inject-config + deploy pipeline
README.md
LICENSE                       # MIT
.nojekyll                     # Tells GitHub Pages not to touch anything
```

No bundler. No `node_modules`. No package.json. One library loads from CDN:
- **Tailwind CSS** (via Play CDN)

---

## Contributing

PRs welcome. Some good candidates:

- Doubles vs. singles mode toggle
- Export/import tournament JSON
- Per-match timing (start/end timestamps)
- Best-of-3 match format
- Polling fallback for browsers without EventSource (old Opera, IE)

## License

MIT — see [LICENSE](./LICENSE).
