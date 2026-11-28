/**
 * POST /api/review/:id {title, description, categoryIds, tags, then} — save a
 * reviewed imported draft, then keep it as a draft, publish it, or move it to
 * the trash (IMP-04, D-62). A blocked publish answers with the reasons.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { ReviewSave, actorOf, api, json, readJson, saveReview } from '@cg/core/admin';

export const POST: APIRoute = ({ request, params }) =>
  api(async () => {
    const input = ReviewSave.parse(await readJson(request));
    return json(await saveReview(env.DB, String(params['id']), input, actorOf(request)));
  });
