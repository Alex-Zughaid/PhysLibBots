# PhysLibBots

A Cloudflare Worker ([`zulip-dm-relay/`](zulip-dm-relay/)) that reports on
open PRs/reviewer load in
[Alex-Zughaid/physlib](https://github.com/Alex-Zughaid/physlib), triggered by
DMing a Zulip bot. Lives in its own repo so it's independent of physlib's own
history/PRs.

No GitHub Actions involved - the Worker calls the GitHub and Zulip APIs
directly. See [`zulip-dm-relay/README.md`](zulip-dm-relay/README.md) for
deploy steps and required secrets.
