import { Router } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { shareLinkSchema } from '@gml/shared';
import { env } from '../config/env.js';
import { HttpError } from '../lib/errors.js';
import { created, handler, ok, parseBody } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { logActivity } from '../lib/activity.js';
import { requireAuth, requireShareToken } from '../middleware/auth.js';
import { resolvePublicOrigin } from '../lib/origin.js';
import { computeAllGarmentStats, computeHealth, loadDataset } from '../services/stats.js';

export const shareRouter = Router();
shareRouter.use(requireAuth);

shareRouter.post(
  '/',
  handler(async (req, res) => {
    const body = parseBody(shareLinkSchema, req.body);
    if (body.scope === 'garment' && body.garmentIds.length === 0) {
      throw new HttpError('VALIDATION_FAILED', '请至少选择一件要分享的衣物');
    }
    const garments = await prisma.garment.findMany({
      where: { id: { in: body.garmentIds }, wardrobeId: req.ctx.wardrobeId, deletedAt: null },
      select: { id: true },
    });
    if (garments.length !== body.garmentIds.length) {
      throw new HttpError('VALIDATION_FAILED', '有衣物不在你的衣橱里');
    }

    const token = randomBytes(24).toString('base64url');
    const expiresInHours = body.expiresInHours ?? env.shareLinkTtlHours;
    const link = await prisma.shareLink.create({
      data: {
        wardrobeId: req.ctx.wardrobeId,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        scope: body.scope,
        garmentIds: body.garmentIds,
        expiresAt: new Date(Date.now() + expiresInHours * 3_600_000),
        createdBy: req.ctx.userId,
      },
    });
    await logActivity({
      wardrobeId: req.ctx.wardrobeId,
      actorId: req.ctx.userId,
      entityType: 'share_link',
      entityId: link.id,
      action: 'create',
      diff: { scope: body.scope, garmentIds: body.garmentIds, expiresInHours },
      requestId: req.ctx.requestId,
    });
    created(req, res, {
      id: link.id,
      token,
      url: `${resolvePublicOrigin(req)}/share/${token}`,
      expiresAt: link.expiresAt,
      scope: link.scope,
      garmentIds: link.garmentIds,
    });
  }),
);

shareRouter.get(
  '/',
  handler(async (req, res) => {
    const links = await prisma.shareLink.findMany({
      where: { wardrobeId: req.ctx.wardrobeId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    ok(req, res, {
      links: links.map((l) => ({
        id: l.id,
        scope: l.scope,
        garmentIds: l.garmentIds,
        expiresAt: l.expiresAt,
        accessCount: l.accessCount,
        lastAccessAt: l.lastAccessAt,
        expired: l.expiresAt.getTime() < Date.now(),
      })),
    });
  }),
);

shareRouter.delete(
  '/:id',
  handler(async (req, res) => {
    const link = await prisma.shareLink.findFirst({
      where: { id: req.params.id, wardrobeId: req.ctx.wardrobeId },
    });
    if (!link) throw new HttpError('NOT_FOUND', '分享链接不存在');
    await prisma.shareLink.update({ where: { id: link.id }, data: { revokedAt: new Date() } });
    ok(req, res, { revoked: true });
  }),
);

/** 访客入口：公开，但只能读到分享范围内的只读数据 */
export const sharePublicRouter = Router();

sharePublicRouter.get(
  '/:token',
  requireShareToken,
  handler(async (req, res) => {
    const share = req.share!;
    const wardrobe = await prisma.wardrobe.findUniqueOrThrow({ where: { id: share.wardrobeId } });
    const garments = await prisma.garment.findMany({
      where: {
        wardrobeId: share.wardrobeId,
        deletedAt: null,
        ...(share.scope === 'wardrobe' ? {} : { id: { in: share.garmentIds } }),
      },
      select: { id: true, code: true, name: true, materialPrimary: true, status: true },
    });
    const link = await prisma.shareLink.findUniqueOrThrow({ where: { id: share.shareLinkId } });
    ok(req, res, {
      wardrobeName: wardrobe.name,
      scope: share.scope,
      garments,
      expiresAt: link.expiresAt,
    });
  }),
);

sharePublicRouter.get(
  '/:token/garment/:garmentId',
  requireShareToken,
  handler(async (req, res) => {
    const share = req.share!;
    if (share.scope !== 'wardrobe' && !share.garmentIds.includes(req.params.garmentId)) {
      throw new HttpError('FORBIDDEN', '这件衣物不在分享范围内');
    }
    const garment = await prisma.garment.findFirst({
      where: { id: req.params.garmentId, wardrobeId: share.wardrobeId, deletedAt: null },
    });
    if (!garment) throw new HttpError('NOT_FOUND', '衣物档案不存在');

    const [photos, damages] = await Promise.all([
      prisma.garmentPhoto.findMany({
        where: { garmentId: garment.id, deletedAt: null },
        include: { annotations: { include: { part: true, damageEvent: { include: { damageType: true } } } } },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.damageEvent.findMany({
        where: { garmentId: garment.id },
        include: { damageType: true, part: true, repairs: { include: { stitch: true, change: true, reviews: true } } },
        orderBy: { detectedAt: 'desc' },
      }),
    ]);
    const dataset = await loadDataset(share.wardrobeId, { includeRetired: true });
    const stats = computeAllGarmentStats(dataset).get(garment.id);

    ok(req, res, {
      // 只读视图：不包含成本、收纳位置等隐私字段
      garment: {
        id: garment.id,
        code: garment.code,
        name: garment.name,
        category: garment.category,
        materialPrimary: garment.materialPrimary,
        knitOrWoven: garment.knitOrWoven,
        seasonTags: garment.seasonTags,
        color: garment.color,
        status: garment.status,
        careNote: garment.careNote,
      },
      photos,
      damages,
      summary: stats
        ? {
            wearCount: stats.wearCount,
            repairCount: stats.repairCount,
            recurrenceRate: stats.recurrenceRate,
            health: computeHealth(stats),
          }
        : null,
    });
  }),
);
