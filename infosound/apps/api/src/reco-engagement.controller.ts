import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Header,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { db, secret } from '@infosound/database';
import {
  recordClick,
  recordEngagement,
  recordImpressions,
  verifyImpressionToken,
  type ImpressionClaims,
} from '@infosound/recommendation-ai/server';
import { Current, Identity, Public, type AuthRequest } from './security';
import { throttle, uuid, validate } from './helpers';
import { readListenToken } from './listens';

const surfaceSchema = z.string().regex(/^[A-Za-z0-9_:-]{1,32}$/);
const impressionTokenSchema = z.string().min(1).max(16_384);
const impressionsSchema = z
  .object({
    requestId: z.string().uuid(),
    impressionToken: impressionTokenSchema,
    surface: surfaceSchema,
    items: z
      .array(
        z
          .object({
            trackId: z.string().uuid(),
            position: z.number().int().min(0).max(1000),
            reason: z.string().regex(/^[A-Z_]{1,16}$/),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();
const clickSchema = z
  .object({ requestId: z.string().uuid(), trackId: z.string().uuid(), impressionToken: impressionTokenSchema })
  .strict();
const engagementSchema = z
  .object({
    token: z.string().min(1).max(4096),
    event: z.enum(['start', 'skip', 'complete']),
  })
  .strict();

function requireCsrfHeader(req: AuthRequest) {
  if (req.headers['x-infosound-csrf'] !== '1')
    throw new ForbiddenException({ code: 'CSRF_HEADER_REQUIRED', message: 'Thiếu xác nhận yêu cầu.' });
}

/** Only the server-issued, user-bound token proves which request/tracks were actually served. */
function servedClaims(user: Identity, requestId: string, token: string): ImpressionClaims {
  const claims = verifyImpressionToken(secret('JWT_SECRET'), token, { userId: user.id, requestId });
  if (!claims)
    throw new BadRequestException({
      code: 'IMPRESSION_TOKEN_INVALID',
      message: 'Phiên gợi ý không hợp lệ.',
    });
  return claims;
}

/** Feedback for the recommender. Accounts only; visitors are never tracked. */
@ApiTags('InfoSound recommendations')
@Controller('api/v1')
export class RecoEngagementController {
  @ApiBearerAuth()
  @Post('recommendations/impressions')
  @HttpCode(204)
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({
    summary:
      'Record which served recommendations the current account saw; requires that response’s impressionToken, idempotent per request and song',
  })
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['requestId', 'impressionToken', 'surface', 'items'],
      properties: {
        requestId: { type: 'string', format: 'uuid' },
        impressionToken: { type: 'string', maxLength: 16384 },
        surface: { type: 'string', pattern: '^[A-Za-z0-9_:-]{1,32}$' },
        items: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['trackId', 'position', 'reason'],
            properties: {
              trackId: { type: 'string', format: 'uuid' },
              position: { type: 'integer', minimum: 0, maximum: 1000 },
              reason: { type: 'string', pattern: '^[A-Z_]{1,16}$' },
            },
          },
        },
      },
    },
  })
  async impressions(@Current() user: Identity, @Body() body: unknown, @Req() req: AuthRequest): Promise<void> {
    requireCsrfHeader(req);
    throttle(`reco-impressions:${user.id}`, 60);
    const input = validate(impressionsSchema, body);
    const claims = servedClaims(user, input.requestId, input.impressionToken);
    const served = new Map(claims.items.map((item) => [item.trackId, item.reason]));
    // Only served tracks are stored, with the server's reason; anything else in the body is ignored.
    const unique = [...new Map(input.items.map((item) => [item.trackId.toLowerCase(), item])).values()];
    const items = unique.flatMap((item) => {
      const trackId = item.trackId.toLowerCase();
      const reason = served.get(trackId);
      return reason ? [{ trackId, position: item.position, reason }] : [];
    });
    await recordImpressions(db, {
      userId: user.id,
      requestId: claims.requestId,
      modelVersion: claims.modelVersion,
      surface: input.surface,
      items,
    });
  }

  @ApiBearerAuth()
  @Post('recommendations/clicks')
  @HttpCode(204)
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'Mark a recommended song from the current account’s own impression as opened' })
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['requestId', 'trackId', 'impressionToken'],
      properties: {
        requestId: { type: 'string', format: 'uuid' },
        trackId: { type: 'string', format: 'uuid' },
        impressionToken: { type: 'string', maxLength: 16384 },
      },
    },
  })
  async clicks(@Current() user: Identity, @Body() body: unknown, @Req() req: AuthRequest): Promise<void> {
    requireCsrfHeader(req);
    throttle(`reco-clicks:${user.id}`, 60);
    const input = validate(clickSchema, body);
    const claims = servedClaims(user, input.requestId, input.impressionToken);
    const trackId = input.trackId.toLowerCase();
    const index = claims.items.findIndex((item) => item.trackId === trackId);
    if (index < 0) return; // not served in this request: ignored
    await recordClick(db, {
      userId: user.id,
      requestId: claims.requestId,
      modelVersion: claims.modelVersion,
      trackId,
      position: index + 1,
      reason: claims.items[index]!.reason,
    });
  }

  @Public()
  @Post('tracks/:id/engagement')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({
    summary:
      'Record a start / skip / complete for the current account using the listen token; one start and one terminal event per token. Visitors receive 204 and nothing is stored.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['token', 'event'],
      properties: {
        token: { type: 'string', minLength: 1, maxLength: 4096 },
        event: { type: 'string', enum: ['start', 'skip', 'complete'] },
      },
    },
  })
  @ApiOkResponse({
    schema: { type: 'object', required: ['recorded'], properties: { recorded: { type: 'boolean' } } },
  })
  async engagement(
    @Current() user: Identity | undefined,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ recorded: boolean } | undefined> {
    requireCsrfHeader(req);
    const trackId = uuid(id);
    if (!user) {
      res.status(204);
      return undefined;
    }
    const input = validate(engagementSchema, body);
    throttle(`reco-engagement:${user.id}`, 120);
    // Terminal events may arrive after the 15-minute token expiry; recordEngagement bounds their age
    // to max(15 min, 2·duration). A start keeps normal expiry.
    const claims = readListenToken(input.token, user, trackId, { ignoreExpiration: input.event !== 'start' });
    const status = await recordEngagement(db, {
      userId: user.id,
      trackId,
      tokenId: claims.jti,
      sourceVersion: claims.sourceVersion,
      startedAtMs: claims.startedAtMs,
      event: input.event,
    });
    if (status === 'UNAVAILABLE')
      throw new NotFoundException({ code: 'TRACK_UNAVAILABLE', message: 'Bài hát hiện không khả dụng.' });
    return { recorded: status === 'RECORDED' };
  }
}
