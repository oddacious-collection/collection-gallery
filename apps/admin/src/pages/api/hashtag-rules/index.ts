/**
 * PUT /api/hashtag-rules {hashtag, categoryId, tagName} — set the rule for a
 * hashtag; with neither a category nor a tag, remove it (D-62 (3)).
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { HashtagRule, actorOf, api, json, readJson, setHashtagRule } from '@cg/core/admin';

export const PUT: APIRoute = ({ request }) =>
  api(async () => {
    const input = HashtagRule.parse(await readJson(request));
    await setHashtagRule(env.DB, input, actorOf(request));
    return json({ ok: true });
  });
