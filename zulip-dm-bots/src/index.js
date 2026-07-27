// Script to get the repo updates, triggered by a Zulip DM

const GITHUB_API = "https://api.github.com";
const DAY_MS = 24 * 60 * 60 * 1000;

const COMMANDS = {
  "/reviews": sendReviewReport,
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Public read-only JSON version of the same report the /reviews command
    // sends over Zulip - lets other things (e.g. the physlib website) reuse
    // this exact computation instead of re-implementing it elsewhere.
    if (request.method === "GET" && url.pathname === "/report") {
      return handleReportApi(env, ctx);
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    // Zulip includes the token you set when creating the outgoing webhook
    // bot. This is how we know the request actually came from Zulip and not
    // some random caller who found this URL.
    if (payload.token !== env.ZULIP_WEBHOOK_TOKEN) {
      return new Response("Unauthorized", { status: 401 });
    }

    // Only handle DMs and stream @-mentions - ignore anything else.
    if (payload.trigger !== "direct_message" && payload.trigger !== "mention") {
      console.log("Ignoring trigger:", payload.trigger);
      return jsonResponse({});
    }

    // For stream mentions Zulip may or may not strip the @**BotName** prefix
    // from payload.data depending on the server version. Strip it defensively.
    const rawData = (payload.data || "").trim();
    const command = rawData.replace(/^@\*\*[^*]+\*\*\s*/, "").trim();
    console.log("trigger:", payload.trigger, "raw data:", rawData, "command:", command);
    const handler = COMMANDS[command];
    if (!handler) {
      console.log("Unknown command:", command);
      return jsonResponse({});
    }

    const destination =
      payload.trigger === "direct_message"
        ? {
            type: "direct",
            // For group DMs, display_recipient is an array of {id, ...} objects.
            // Reply to all participants so the response goes to the whole group.
            userIds: Array.isArray(payload.message?.display_recipient)
              ? payload.message.display_recipient.map((u) => u.id)
              : [payload.message?.sender_id],
          }
        : {
            type: "stream",
            streamId: payload.message?.stream_id,
            topic: payload.message?.subject ?? payload.message?.topic,
          };

    // Building the report makes several sequential GitHub API calls, which
    // can take longer than Zulip's webhook timeout. Acknowledge immediately
    // and do the real work in the background, delivering the result as a
    // follow-up message once it's ready.
    ctx.waitUntil(runCommand(handler, env, destination));

    return jsonResponse({ content: "One sec, working on it..." });
  },
};

async function runCommand(handler, env, destination) {
  try {
    await handler(env, destination);
  } catch (err) {
    console.error("Command failed", err);
    await postToZulip(
      env,
      destination,
      `Sorry, something went wrong: ${err.message}`
    ).catch(() => {});
  }
}

async function sendReviewReport(env, destination) {
  const report = await buildReport(env);
  const message = formatMessage(report);
  await postToZulip(env, destination, message);
}

const REPORT_CACHE_SECONDS = 300;
// Bump this when the report's JSON shape changes, so old cached entries
// don't linger for up to REPORT_CACHE_SECONDS serving a stale shape.
const REPORT_VERSION = "v2";

async function handleReportApi(env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(
    `https://zulip-dm-relay.internal/report/${REPORT_VERSION}`
  );

  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  let report;
  try {
    report = await buildReport(env);
  } catch (err) {
    console.error("Failed to build report for /report", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  const response = new Response(JSON.stringify(report), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${REPORT_CACHE_SECONDS}`,
      // Fetched client-side (browser) from the physlib website, which is a
      // different origin - this is public, read-only data, so open CORS.
      "Access-Control-Allow-Origin": "*",
    },
  });

  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

async function ghRequest(env, path, params) {
  const url = new URL(`${GITHUB_API}${path}`);
  for (const [k, v] of Object.entries(params || {})) {
    url.searchParams.set(k, v);
  }
  const resp = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${env.GH_TOKEN}`,
      "User-Agent": "physlib-bots-relay",
    },
  });
  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`GitHub API error for ${url}: ${resp.status} ${detail}`);
  }
  const data = await resp.json();
  return [data, resp.headers.get("Link") || ""];
}

async function ghPaginate(env, path, params = {}) {
  let page = 1;
  const results = [];
  while (true) {
    const [data, link] = await ghRequest(env, path, {
      ...params,
      per_page: 100,
      page,
    });
    if (!data.length) break;
    results.push(...data);
    if (!link.includes('rel="next"')) break;
    page++;
  }
  return results;
}

function fetchOpenPRs(env) {
  return ghPaginate(env, `/repos/${env.TARGET_OWNER}/${env.TARGET_REPO}/pulls`, {
    state: "open",
    sort: "created",
    direction: "desc",
  });
}

async function fetchPRLinesChanged(env, number) {
  const [data] = await ghRequest(
    env,
    `/repos/${env.TARGET_OWNER}/${env.TARGET_REPO}/pulls/${number}`
  );
  return (data.additions || 0) + (data.deletions || 0);
}

// Uses the Search API (rather than paginating /pulls and filtering by date)
// so this stays a small, bounded number of requests regardless of how much
// closed-PR history the repo has - paginating and filtering client-side
// means scanning the *entire* history every time, which blows through a
// Worker's per-invocation subrequest limit on an active repo.
async function ghSearchIssues(env, query) {
  const results = [];
  let page = 1;
  while (true) {
    const url = new URL(`${GITHUB_API}/search/issues`);
    url.searchParams.set("q", query);
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", page);
    const resp = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        Authorization: `Bearer ${env.GH_TOKEN}`,
        "User-Agent": "physlib-bots-relay",
      },
    });
    if (!resp.ok) {
      const detail = await resp.text();
      throw new Error(`GitHub search API error for ${url}: ${resp.status} ${detail}`);
    }
    const data = await resp.json();
    results.push(...data.items);
    if (data.items.length < 100) break;
    page++;
  }
  return results;
}

function isoCutoff() {
  return new Date(Date.now() - DAY_MS).toISOString().slice(0, 19);
}

function fetchRecentlyMergedPRs(env) {
  return ghSearchIssues(
    env,
    `repo:${env.TARGET_OWNER}/${env.TARGET_REPO} is:pr is:merged merged:>=${isoCutoff()}`
  );
}

function fetchRecentlyOpenedPRs(env) {
  return ghSearchIssues(
    env,
    `repo:${env.TARGET_OWNER}/${env.TARGET_REPO} is:pr created:>=${isoCutoff()}`
  );
}

// Gets people who aren't assigned as a reviewer, but have pushed to the repo
// in the past - needed to find people currently assigned to 0 reviews.
async function fetchCollaborators(env) {
  try {
    const collabs = await ghPaginate(
      env,
      `/repos/${env.TARGET_OWNER}/${env.TARGET_REPO}/collaborators`,
      { affiliation: "all" }
    );
    return collabs.map((c) => c.login);
  } catch (err) {
    console.error(
      "Warning: could not list collaborators (needs push access on the repo). " +
        "Roster will be built from requested reviewers only.",
      err
    );
    return [];
  }
}

async function buildReport(env) {
  const busyThreshold = Number(env.BUSY_THRESHOLD || "3");
  const maxPrsListed = Number(env.MAX_PRS_LISTED || "3");

  const prs = await fetchOpenPRs(env);

  const pendingCounts = {};
  const pendingPRs = {}; // reviewer -> list of {number, title, url}
  const unreviewedPRs = []; // open PRs with no reviewer assigned

  for (const pr of prs) {
    const reviewers = (pr.requested_reviewers || []).map((r) => r.login);

    if (reviewers.length === 0) {
      const labels = (pr.labels || []).map((l) => l.name);
      const linesChanged = await fetchPRLinesChanged(env, pr.number);
      unreviewedPRs.push({
        number: pr.number,
        title: pr.title,
        url: pr.html_url,
        labels,
        linesChanged,
      });
    }
    for (const login of reviewers) {
      pendingCounts[login] = (pendingCounts[login] || 0) + 1;
      (pendingPRs[login] ||= []).push({
        number: pr.number,
        title: pr.title,
        url: pr.html_url,
      });
    }
  }

  const mergedRecently = await fetchRecentlyMergedPRs(env);
  const openedRecently = await fetchRecentlyOpenedPRs(env);

  const collaborators = await fetchCollaborators(env);
  const roster = Array.from(
    new Set([...collaborators, ...Object.keys(pendingCounts)])
  ).sort();

  const busy = [];
  const moderate = [];
  const quiet = [];
  for (const login of roster) {
    const count = pendingCounts[login] || 0;
    if (count >= busyThreshold) busy.push([login, count]);
    else if (count === 0) quiet.push([login, count]);
    else moderate.push([login, count]);
  }
  busy.sort((a, b) => b[1] - a[1]);
  moderate.sort((a, b) => b[1] - a[1]);
  quiet.sort((a, b) => a[0].localeCompare(b[0]));

  return {
    busyThreshold,
    maxPrsListed,
    busy,
    moderate,
    quiet,
    pendingPRs,
    unreviewedPRs,
    // Full open-PR list (already fetched above for the unreviewed-PR pass) -
    // exposed as-is so consumers like the physlib website can build their
    // own PR listings/categorizations from one shared data source instead
    // of each making a separate GitHub API call.
    openPRs: prs.map((pr) => ({
      number: pr.number,
      title: pr.title,
      html_url: pr.html_url,
      draft: pr.draft,
      created_at: pr.created_at,
      user: pr.user ? { login: pr.user.login } : null,
      labels: (pr.labels || []).map((l) => ({ name: l.name, color: l.color })),
    })),
    mergedRecently: mergedRecently.map((pr) => ({
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      author: pr.user.login,
    })),
    openedRecently: openedRecently.map((pr) => ({
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      author: pr.user.login,
    })),
  };
}

function formatMessage(report) {
  const lines = [];
  lines.push("Summary of PRs that need attention and available reviewers");
  lines.push("");

  const section = (title, entries, showPRs = false) => {
    lines.push(`**${title}** (${entries.length})`);
    if (entries.length === 0) {
      lines.push("- _none_");
    } else {
      for (const [login, count] of entries) {
        const suffix = count ? ` — ${count} pending review(s)` : "";
        lines.push(`- @**${login}**${suffix}`);
        if (showPRs) {
          for (const pr of (report.pendingPRs[login] || []).slice(
            0,
            report.maxPrsListed
          )) {
            lines.push(`    - [#${pr.number} ${pr.title}](${pr.url})`);
          }
        }
      }
    }
    lines.push("");
  };

  const unreviewed = report.unreviewedPRs;
  lines.push(`**⚪ Open PRs with no reviewer assigned** (${unreviewed.length})`);
  if (unreviewed.length === 0) lines.push("- _none_");
  for (const pr of unreviewed) {
    const tagStr = pr.labels.length
      ? " " + pr.labels.map((l) => `\`${l}\``).join(" ")
      : "";
    lines.push(
      `- [#${pr.number} ${pr.title}](${pr.url})${tagStr} — ${pr.linesChanged} lines changed`
    );
  }
  lines.push("");

  section(`🔴 Busy (≥${report.busyThreshold} pending reviews)`, report.busy, true);
  section("🟡 Moderate", report.moderate);
  section("🟢 Quiet (0 pending reviews)", report.quiet);

  const opened = report.openedRecently;
  lines.push(`**🟤 Opened in the last 24h** (${opened.length})`);
  if (opened.length === 0) lines.push("- _none_");
  for (const pr of opened) {
    lines.push(`- [#${pr.number} ${pr.title}](${pr.url}) by @**${pr.author}**`);
  }
  lines.push("");

  const merged = report.mergedRecently;
  lines.push(`**✅ Merged in the last 24h** (${merged.length})`);
  if (merged.length === 0) lines.push("- _none_");
  for (const pr of merged) {
    lines.push(`- [#${pr.number} ${pr.title}](${pr.url}) by @**${pr.author}**`);
  }
  lines.push("");

  return lines.join("\n");
}

async function postToZulip(env, destination, content) {
  const params =
    destination.type === "direct"
      ? { type: "direct", to: JSON.stringify(destination.userIds), content }
      : {
          type: "stream",
          to: String(destination.streamId),
          topic: destination.topic || "",
          content,
        };
  const body = new URLSearchParams(params);

  const credentials = btoa(`${env.ZULIP_BOT_EMAIL}:${env.ZULIP_BOT_API_KEY}`);

  const resp = await fetch(`${env.ZULIP_SITE.replace(/\/$/, "")}/api/v1/messages`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const text = await resp.text();
  if (!resp.ok) {
    console.error("Zulip API error", resp.status, text);
    throw new Error(`Zulip API error: ${resp.status} ${text}`);
  }
  console.log("Zulip response:", text);
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}
