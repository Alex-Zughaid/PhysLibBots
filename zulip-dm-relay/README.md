# Zulip bot commands

Cloudflare Worker behind a Zulip bot that responds to commands - either DMed
directly, or by @-mentioning the bot in a stream thread (e.g.
`@**bot-name** /reviews`). Commands are a small lookup table in
`src/index.js` (`COMMANDS`), currently just:

- `/reviews` - builds a report of open PRs and reviewer load on
  [leanprover-community/physlib](https://github.com/leanprover-community/physlib)
  (via the GitHub API) and sends it back. DMs get a DM reply; mentions in a
  stream get a reply in that same stream/topic.

GitHub Actions has no native "Zulip DM"/mention trigger, and Zulip's outgoing
webhook can't call arbitrary APIs directly with the right auth, so this
Worker is the bridge - and since it already has to talk to both APIs for
that handshake, it just does the work itself rather than handing off to a
separate workflow.

For @-mentions to trigger the webhook, the bot needs to be **subscribed to
the stream** where you're mentioning it - add it there in Zulip if mentions
aren't triggering anything.

## Deploy

1. Create a free Cloudflare account at https://dash.cloudflare.com/sign-up.
2. Create a GitHub fine-grained personal access token scoped to **"Public
   Repositories (read-only)"** (since `leanprover-community/physlib` is
   public and you're not a collaborator there, "selected repositories"
   won't let you pick it - the public-read option covers any public repo).
   Note the `/collaborators` endpoint used to build the reviewer roster
   requires push access, which this token won't have, so that call will
   fail gracefully and fall back to an empty collaborator list (see
   `fetchCollaborators` in `src/index.js`) - the roster will only include
   people with pending review requests, not the full collaborator list.
3. From this directory:
   ```bash
   npx wrangler login
   npx wrangler secret put GH_TOKEN             # paste the token from step 2
   npx wrangler secret put ZULIP_WEBHOOK_TOKEN  # any random string, e.g. `openssl rand -hex 20`
   npx wrangler secret put ZULIP_SITE           # e.g. https://leanprover.zulipchat.com
   npx wrangler secret put ZULIP_BOT_EMAIL      # the report-sending bot's email
   npx wrangler secret put ZULIP_BOT_API_KEY    # that same bot's API key
   npx wrangler deploy
   ```
   This prints a `*.workers.dev` URL.
4. In Zulip, create an **Outgoing webhook** bot (Settings -> Personal
   settings -> Bots -> Add a new bot), interface "Generic", endpoint URL =
   the `workers.dev` URL from step 3, and set the bot's token to the same
   string used for `ZULIP_WEBHOOK_TOKEN` above.
5. DM the bot `/reviews`, or @-mention it with `/reviews` in a stream it's
   subscribed to. You should get an instant "One sec..." reply, then the
   full report as a follow-up message a few seconds later.

Debug with `npx wrangler tail` while sending a test DM.
