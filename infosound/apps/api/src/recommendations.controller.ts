import { Body, Controller, Get, Header, HttpCode, NotFoundException, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { db, secret } from '@infosound/database';
import {
  hybridRecommendations,
  recommendationExplain,
  recommendationShelves,
  signImpressionToken,
  type RecoItem,
} from '@infosound/recommendation-ai/server';
import { Current, Identity, Public } from './security';
import { publicTrackWhere, throttle, trackInclude, viewTrack } from './helpers';
import { fullTrackView } from './openapi';
import {
  previewRecommendationSelection,
  RecommendationSource,
  userRecommendationSelection,
} from './recommendations';
import {
  musicPreferencesView,
  readMusicPreferences,
  validateMusicPreferences,
} from './music-preferences';

const preferencesBody = {
  type: 'object' as const,
  additionalProperties: false,
  required: ['genreIds', 'artistIds'],
  properties: {
    genreIds: {
      type: 'array' as const,
      maxItems: 50,
      items: { type: 'string' as const, minLength: 1, maxLength: 100 },
    },
    artistIds: {
      type: 'array' as const,
      maxItems: 50,
      items: { type: 'string' as const, format: 'uuid' },
    },
  },
};
const preferencesView = {
  type: 'object' as const,
  required: ['genreIds', 'artistIds', 'status', 'hasLikedPreferences'],
  properties: {
    ...preferencesBody.properties,
    status: { type: 'string' as const, enum: ['NEW', 'SAVED', 'SKIPPED'] },
    hasLikedPreferences: { type: 'boolean' as const },
  },
};
const recommendationsView = {
  type: 'object' as const,
  required: ['items', 'reason', 'source'],
  properties: {
    items: { type: 'array' as const, maxItems: 5, items: fullTrackView },
    reason: { type: 'string' as const, enum: ['MATCHED', 'POPULAR', 'NO_MATCHES'] },
    source: { type: 'string' as const, enum: ['PREFERENCES', 'LIKES', 'POPULAR'] },
  },
};
const recommendationMeta = {
  type: 'object' as const,
  required: ['reason'],
  properties: {
    reason: { type: 'string' as const, enum: ['LISTENED', 'SIMILAR', 'FOLLOW', 'TRENDING', 'EXPLORE'] },
    seedTitle: { type: 'string' as const, description: 'Title of a public song from the user’s own history' },
  },
};
const recommendedTrackView = {
  allOf: [fullTrackView, { type: 'object' as const, properties: { recommendation: recommendationMeta } }],
};
const impressionTokenView = {
  type: 'string' as const,
  nullable: true,
  description:
    'Opaque server-signed proof of the served request; send it back with impressions and clicks. Null on fallback.',
};
const userRecommendationsView = {
  type: 'object' as const,
  required: ['items', 'reason', 'source', 'requestId', 'modelVersion', 'impressionToken'],
  properties: {
    items: { type: 'array' as const, maxItems: 5, items: recommendedTrackView },
    reason: recommendationsView.properties.reason,
    source: { type: 'string' as const, enum: ['HYBRID', 'PREFERENCES', 'LIKES', 'POPULAR'] },
    requestId: { type: 'string' as const, format: 'uuid', nullable: true },
    modelVersion: { type: 'string' as const, nullable: true },
    impressionToken: impressionTokenView,
  },
};
const shelvesView = {
  type: 'object' as const,
  required: ['requestId', 'modelVersion', 'impressionToken', 'shelves'],
  properties: {
    requestId: { type: 'string' as const, format: 'uuid', nullable: true },
    modelVersion: { type: 'string' as const, nullable: true },
    impressionToken: impressionTokenView,
    shelves: {
      type: 'array' as const,
      maxItems: 4,
      items: {
        type: 'object' as const,
        required: ['kind', 'items'],
        properties: {
          kind: { type: 'string' as const, enum: ['LISTENED', 'FOLLOW', 'TRENDING', 'FOR_YOU'] },
          seedTitle: { type: 'string' as const },
          items: { type: 'array' as const, maxItems: 10, items: recommendedTrackView },
        },
      },
    },
  },
};

/** Stable event code only: recommendation errors may carry SQL or user data in their message. */
function logRecoFallback(error: unknown) {
  process.stderr.write(
    JSON.stringify({
      level: 'warn',
      event: 'recommendation_hybrid_fallback',
      code: error instanceof Error ? error.name : 'UNKNOWN',
    }) + '\n',
  );
}
const recoOptions = { onError: logRecoFallback };
/** Read-only GETs, but each runs the full pipeline: bounded per account. */
const throttleReco = (user: Identity) => throttle(`reco:${user.id}`, 30);
/** Signs exactly the hydrated (served) tracks, so impressions/clicks cannot be forged. */
function impressionToken(
  user: Identity,
  requestId: string,
  modelVersion: string,
  lists: { id: string; recommendation: { reason: RecoItem['reason'] } }[][],
) {
  return signImpressionToken(secret('JWT_SECRET'), {
    userId: user.id,
    requestId,
    modelVersion,
    items: lists.flat().map((item) => ({ trackId: item.id, reason: item.recommendation.reason })),
  });
}

@ApiTags('InfoSound recommendations')
@Controller('api/v1')
export class RecommendationsController {
  @ApiBearerAuth()
  @Get('recommendations')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({
    summary:
      'Recommend five songs with the hybrid ranker (collaborative + content + follows + trending); without a model, embeddings or three interactions, use saved choices, then liked genres, otherwise public popular songs',
  })
  @ApiOkResponse({ schema: userRecommendationsView })
  async recommendations(@Current() user: Identity) {
    throttleReco(user);
    // Read-only: impressions are reported by the client through POST recommendations/impressions.
    const hybrid = await hybridRecommendations(db, user.id, recoOptions);
    if (hybrid) {
      const items = (await this.hydrateReco([hybrid.items], user))[0]!;
      if (items.length)
        return {
          items,
          reason: 'MATCHED' as const,
          source: 'HYBRID' as const,
          requestId: hybrid.requestId,
          modelVersion: hybrid.modelVersion,
          impressionToken: impressionToken(user, hybrid.requestId, hybrid.modelVersion, [items]),
        };
    }
    return {
      ...(await this.hydrate(await userRecommendationSelection(user.id), user)),
      requestId: null,
      modelVersion: null,
      impressionToken: null,
    };
  }

  @ApiBearerAuth()
  @Get('recommendations/shelves')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({
    summary:
      'Personal shelves in order for you, because you listened, followed artists, trending (no track on two shelves); falls back to a single rule-based shelf',
  })
  @ApiOkResponse({ schema: shelvesView })
  async shelves(@Current() user: Identity) {
    throttleReco(user);
    const result = await recommendationShelves(db, user.id, recoOptions);
    if (result) {
      const hydrated = await this.hydrateReco(result.shelves.map((shelf) => shelf.items), user);
      const shelves = result.shelves.flatMap((shelf, index) => {
        const items = hydrated[index]!;
        if (!items.length) return [];
        return [{ kind: shelf.kind, ...(shelf.seedTitle ? { seedTitle: shelf.seedTitle } : {}), items }];
      });
      if (shelves.length)
        return {
          requestId: result.requestId,
          modelVersion: result.modelVersion,
          impressionToken: impressionToken(
            user,
            result.requestId,
            result.modelVersion,
            shelves.map((shelf) => shelf.items),
          ),
          shelves,
        };
    }
    const fallback = await this.hydrate(await userRecommendationSelection(user.id), user);
    return {
      requestId: null,
      modelVersion: null,
      impressionToken: null,
      shelves: fallback.items.length ? [{ kind: 'FOR_YOU' as const, items: fallback.items }] : [],
    };
  }

  @ApiBearerAuth()
  @Get('recommendations/explain')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({
    summary:
      'Debug view of the current user’s own candidates, features and scores; 404 unless RECO_EXPLAIN_ENABLED=true',
  })
  async explain(@Current() user: Identity) {
    if (process.env.RECO_EXPLAIN_ENABLED !== 'true')
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Không tìm thấy.' });
    throttleReco(user);
    return recommendationExplain(db, user.id, recoOptions);
  }

  @Public()
  @Post('recommendations/preview')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({
    summary:
      'Preview five public recommendations from visitor choices without saving a preference profile',
  })
  @ApiBody({ schema: preferencesBody })
  @ApiOkResponse({ schema: recommendationsView })
  async preview(@Body() body: unknown) {
    return this.hydrate(await previewRecommendationSelection(readMusicPreferences(body)));
  }

  @ApiBearerAuth()
  @Get('me/music-preferences')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({
    summary:
      'Read only the current account’s survey status and currently available catalog choices',
  })
  @ApiOkResponse({ schema: preferencesView })
  preferences(@Current() user: Identity) {
    return musicPreferencesView(user.id);
  }

  @ApiBearerAuth()
  @Put('me/music-preferences')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({
    summary: 'Save current account’s favorite genres/artists; two empty arrays skip the survey',
  })
  @ApiBody({ schema: preferencesBody })
  @ApiOkResponse({ schema: preferencesView })
  async savePreferences(@Current() user: Identity, @Body() body: unknown) {
    const value = await validateMusicPreferences(body);
    await db.musicPreference.upsert({
      where: { userId: user.id },
      create: { userId: user.id, ...value },
      update: value,
    });
    return musicPreferencesView(user.id);
  }

  /**
   * Re-checks visibility at hydration time (public, active author, not own, not liked) and attaches
   * only the reason and seed title; scores and candidate sources never leave the server.
   */
  private async hydrateReco(lists: RecoItem[][], user: Identity) {
    const ids = [...new Set(lists.flat().map((item) => item.trackId))];
    const tracks = ids.length
      ? await db.track.findMany({
          where: {
            id: { in: ids },
            ...publicTrackWhere,
            author: { active: true },
            authorId: { not: user.id },
            likes: { none: { userId: user.id } },
          },
          include: trackInclude,
        })
      : [];
    const views = new Map(
      await Promise.all(tracks.map(async (track) => [track.id, await viewTrack(track, user)] as const)),
    );
    return lists.map((items) =>
      items.flatMap((item) => {
        const view = views.get(item.trackId);
        if (!view) return [];
        const recommendation = item.seedTitle
          ? { reason: item.reason, seedTitle: item.seedTitle }
          : { reason: item.reason };
        return [{ ...view, recommendation }];
      }),
    );
  }

  private async hydrate(
    selected: { ids: string[]; source: RecommendationSource },
    user?: Identity,
  ) {
    // Recheck current visibility and likes after selection; never allow an owner override.
    const tracks = await db.track.findMany({
      where: {
        id: { in: selected.ids },
        ...publicTrackWhere,
        ...(user && selected.source !== 'POPULAR' ? { likes: { none: { userId: user.id } } } : {}),
      },
      include: trackInclude,
    });
    const byId = new Map(tracks.map((track) => [track.id, track]));
    const items = await Promise.all(
      selected.ids.flatMap((id) => {
        const track = byId.get(id);
        return track ? [viewTrack(track, user)] : [];
      }),
    );
    return {
      items,
      reason:
        selected.source === 'POPULAR'
          ? ('POPULAR' as const)
          : items.length
            ? ('MATCHED' as const)
            : ('NO_MATCHES' as const),
      source: selected.source,
    };
  }
}
