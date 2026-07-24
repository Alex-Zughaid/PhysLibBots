# Zulip DM relay

Cloudflare Worker that, when the configured Zulip bot receives a direct
message, builds a report of open PRs and reviewer load on
[Alex-Zughaid/physlib](https://github.com/Alex-Zughaid/physlib) (via the
GitHub API) and sends it back as a Zulip direct message to whoever asked.

GitHub Actions has no native "Zulip DM" trigger, and Zulip's outgoing webhook
can't call arbitrary APIs directly with the right auth, so this Worker is the
bridge - and since it already has to talk to both APIs for that handshake, it
just does the report-building itself rather than handing off to a separate
workflow.

## Deploy

1. Create a free Cloudflare account at https://dash.cloudflare.com/sign-up.
2. Create a GitHub fine-grained personal access token with **read access to
   `Alex-Zughaid/physlib`** (Contents: Read, Pull requests: Read; add
   push/write access too if you want the collaborators list populated - see
   the comment on `fetchCollaborators` in `src/index.js`).
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
5. DM the bot. You should get an instant "One sec..." reply, then the full
   report as a follow-up DM a few seconds later.

Debug with `npx wrangler tail` while sending a test DM.
