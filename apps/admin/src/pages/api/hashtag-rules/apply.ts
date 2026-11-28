/**
 * POST /api/hashtag-rules/apply {cursor} — apply every hashtag rule to the
 * next batch of imported drafts; call again with nextCursor until it is null.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { actorOf, api, applyHashtagRules, json, readJson } from '@cg/core/admin';

const Body = z.strictObject({ cursor: z.string().max(32).nullable() });

export const POST: APIRoute = ({ request }) =>
  api(async () => {
    const { cursor } = Body.parse(await readJson(request));
    return json(await applyHashtagRules(env.DB, actorOf(request), cursor));
  });
