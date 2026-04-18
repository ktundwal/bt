# 🏸 Carnage Courts

A zero-signup, zero-backend, peer-to-peer badminton tournament engine for your Saturday open. Randomize teams, run a round-robin, log scores, crown the champion. Runs entirely in the browser.

- **No accounts.** No database. No server bills.
- **No backend.** State syncs between phones over WebRTC, with signaling over public [Nostr](https://nostr.com) relays via [Trystero](https://github.com/dmotz/trystero). Plain `wss://` traffic that passes through firewalls that block BitTorrent-style signaling.
- **Works offline.** Each device keeps a local copy; missing updates reconcile when peers reconnect.
- **Mobile-first.** Built for sweaty fingers on phone screens.
- **$0 to host.** Static site — deploy to GitHub Pages, Cloudflare Pages, Netlify, or anything that serves HTML.

---

## How it works

1. One person opens the app and **creates a room** with a room name + a 2-digit admin PIN.
2. They share the URL (or room name) with everyone playing.
3. Players open the link on their phones and **add their names**.
4. Admin hits **Randomize Teams** — pairs are shuffled, given ridiculous names, and a full round-robin schedule is generated across however many courts are available.
5. As games finish, anyone with the PIN **logs the score**. The leaderboard updates live on every phone in real time.

### Scoring rules
- First to 21, **win by 1** (21–20 is a valid win).
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
| Reset tournament    | Yes        |

The PIN gates **structural changes only** — who's playing with whom, and how many courts. Scoring is deliberately open because the creator is usually on court, not next to the scoreboard, and blocking on them would stall the tournament.

The PIN is stored only as a SHA-256 hash in the shared state. Cached on the admin's device in `localStorage` so they don't have to re-enter it on every action.

---

## Run locally

No build step. Just serve the directory:

```bash
# any static server works
python3 -m http.server 8080
# then open http://localhost:8080
```

Or with Node:
```bash
npx serve .
```

---

## Deploy to GitHub Pages ($0)

1. Push this repo to GitHub (e.g., `github.com/you/carnage-courts`).
2. Repo **Settings → Pages**: set source to `Deploy from a branch`, branch `main` / `root`.
3. Done. In ~60 seconds your app is live at `https://you.github.io/carnage-courts/`.

The included `.nojekyll` file ensures GitHub doesn't try to process anything — the files ship as-is.

### Alternate hosts (also free)
- **Cloudflare Pages**: connect the repo, build command blank, output dir `/`.
- **Netlify**: drag-and-drop the folder, or connect the repo.
- **Vercel**: `vercel --prod` from the directory.

---

## The peer-to-peer caveat

WebRTC needs both peers to be able to reach each other. In practice:

- ✅ **Same WiFi (venue, home)**: works.
- ✅ **Different home networks**: works most of the time (STUN resolves NAT).
- ✅ **Managed / corporate networks**: usually works — signaling is over plain `wss://` Nostr relays (not BitTorrent trackers, which are commonly blocked).
- ⚠️ **Two devices behind the same symmetric-NAT cellular carrier**: rare, but can fail without a TURN server. Switching one device to WiFi usually fixes it.

If you need bulletproof sync across any network, you can plug in a tiny paid TURN service (e.g. [Open Relay](https://www.metered.ca/tools/openrelay/)). To try a different signaling strategy (MQTT, Firebase, etc.), swap the Trystero import in `app.js` — see [Trystero docs](https://github.com/dmotz/trystero#strategy-comparison).

---

## Project layout

```
index.html      # Markup, Tailwind config inline
styles.css      # A few custom styles on top of Tailwind
app.js          # Single-file app: state, mutations, P2P sync, rendering
README.md
LICENSE         # MIT
.nojekyll       # Tells GitHub Pages not to touch anything
```

No bundler. No `node_modules`. No package.json. Two libraries load from CDN:
- **Tailwind CSS** (via Play CDN)
- **Trystero** (via jsDelivr ESM)

---

## Contributing

PRs welcome. Some good candidates:

- Doubles vs. singles mode toggle
- Export/import tournament JSON
- In-app TURN fallback configuration
- Per-match timing (start/end timestamps)
- Best-of-3 match format

## License

MIT — see [LICENSE](./LICENSE).
