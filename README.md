# PhysLibBots

Automation that reports on open PRs/reviewer load in
[Alex-Zughaid/physlib](https://github.com/Alex-Zughaid/physlib), triggered by
DMing a Zulip bot. Lives in its own repo so it's independent of physlib's own
history/PRs.

## Pieces

- [`.github/workflows/repo-updates.yml`](.github/workflows/repo-updates.yml) -
  runs [`scripts/repo-updates-script.py`](scripts/repo-updates-script.py),
  which queries `physlib`'s PRs/collaborators via the GitHub API and DMs a
  summary back to whoever triggered it, over Zulip.
- [`zulip-dm-relay/`](zulip-dm-relay/) - a Cloudflare Worker that bridges a
  Zulip DM to a `repository_dispatch` event on *this* repo (see its own
  README for deploy steps).

## Required secrets (Settings -> Secrets and variables -> Actions, on this repo)

- `GH_TOKEN` - a PAT with **read access to `Alex-Zughaid/physlib`**
  (Contents: Read, Pull requests: Read; push/write access too if you want
  the collaborators list populated - see the comment in
  `fetch_collaborators` in the script). This is separate from any token used
  by the Worker in `zulip-dm-relay/` - that one only needs write access to
  *this* repo to fire the dispatch event.
- `ZULIP_SITE`, `ZULIP_BOT_EMAIL`, `ZULIP_BOT_API_KEY` - the Zulip bot that
  sends the report back as a DM. `ZULIP_BOT_EMAIL`/`ZULIP_BOT_API_KEY` must
  be a matched pair for the *same* bot (mismatched email/key gives a 401).
