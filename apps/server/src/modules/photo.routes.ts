import { Router, type Request } from 'express';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import {
  annotationBatchSchema,
  annotationBaseSchema,
  annotationInputSchema,
  photoUpdateSchema,
  photoUploadSchema,
  pointGeometrySchema,
  polylineGeometrySchema,
  rectGeometrySchema,
  roundCoord,
  type AnnotationInput,
} from '@gml/shared';
import { HttpError } from '../lib/errors.js';
import { created, handler, ok, parseBody } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { logActivity } from '../lib/activity.js';
import { verifyToken } from '../lib/auth.js';
import { hashShareToken } from '../middleware/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { photoUpload } from '../middleware/upload.js';
import { absolutePath, processPhoto } from '../services/image.js';
import { parseDateOnly } from '../lib/date.js';

export const photoRouter = Router();

/** 照片读取：登录用户或有效分享链接都可以，但必须经过归属校验 */
async function authorizePhotoRead(req: Request, photoId: string) {
  const photo = await prisma.garmentPhoto.findFirst({
    where: { id: photoId, deletedAt: null },
    include: { garment: { select: { id: true, wardrobeId: true, name: true } } },
  });
  if (!photo) throw new HttpError('NOT_FOUND', '照片不存在');

  const shareToken = typeof req.query.share === 'string' ? req.query.share : '';
  if (shareToken) {
    const link = await prisma.shareLink.findUnique({ where: { tokenHash: hashShareToken(shareToken) } });
    if (!link || link.revokedAt) throw new HttpError('AUTH_REQUIRED', '分享链接已失效');
    if (link.expiresAt.getTime() < Date.now()) throw new HttpError('SHARE_LINK_EXPIRED', '分享链接已过期');
    const scopeIds = Array.isArray(link.garmentIds) ? (link.garmentIds as string[]) : [];
    if (link.scope !== 'wardrobe' && !scopeIds.includes(photo.garmentId)) {
      throw new HttpError('FORBIDDEN', '该照片不在分享范围内');
    }
    return photo;
  }

  const header = req.header('authorization');
  const raw =
    header?.toLowerCase().startsWith('bearer ')
      ? header.slice(7).trim()
      : typeof req.query.token === 'string'
        ? req.query.token
        : '';
  if (!raw) throw new HttpError('AUTH_REQUIRED', '请先登录');
  const payload = verifyToken(raw);
  if (payload.wardrobeId !== photo.garment.wardrobeId) throw new HttpError('FORBIDDEN', '无权访问这张照片');
  return photo;
}

photoRouter.get(
  '/photos/:id/file',
  handler(async (req, res) => {
    const photo = await authorizePhotoRead(req, req.params.id);
    const filePath = absolutePath(photo.storagePath);
    const info = await stat(filePath).catch(() => null);
    if (!info) throw new HttpError('NOT_FOUND', '照片文件丢失，请检查备份');
    res.setHeader('content-type', photo.mimeType);
    res.setHeader('cache-control', 'private, max-age=3600');
    res.setHeader('etag', `"${photo.sha256}"`);
    createReadStream(filePath).pipe(res);
  }),
);

photoRouter.get(
  '/photos/:id/thumb',
  handler(async (req, res) => {
    const photo = await authorizePhotoRead(req, req.params.id);
    const filePath = absolutePath(photo.thumbPath);
    const info = await stat(filePath).catch(() => null);
    if (!info) throw new HttpError('NOT_FOUND', '缩略图丢失');
    res.setHeader('content-type', 'image/webp');
    res.setHeader('cache-control', 'private, max-age=86400');
    createReadStream(filePath).pipe(res);
  }),
);

photoRouter.post(
  '/garments/:garmentId/photos',
  requireAuth,
  photoUpload.single('file'),
  handler(async (req, res) => {
    const garment = await prisma.garment.findFirst({
      where: { id: req.params.garmentId, wardrobeId: req.ctx.wardrobeId, deletedAt: null },
    });
    if (!garment) throw new HttpError('NOT_FOUND', '衣物档案不存在');
    if (!req.file) throw new HttpError('VALIDATION_FAILED', '请选择要上传的图片');

    const body = parseBody(photoUploadSchema, req.body ?? {});
    const processed = await processPhoto(req.file.buffer, {
      wardrobeId: req.ctx.wardrobeId,
      garmentId: garment.id,
    });

    const photo = await prisma.garmentPhoto.create({
      data: {
        garmentId: garment.id,
        view: body.view,
        storagePath: processed.storagePath,
        thumbPath: processed.thumbPath,
        originalName: req.file.originalname,
        mimeType: processed.mimeType,
        width: processed.width,
        height: processed.height,
        sizeBytes: processed.sizeBytes,
        sha256: processed.sha256,
        capturedAt: body.capturedAt ? parseDateOnly(body.capturedAt) : null,
        exifStripped: true,
        note: body.note ?? null,
        createdBy: req.ctx.userId,
      },
    });
    await logActivity({
      wardrobeId: req.ctx.wardrobeId,
      actorId: req.ctx.userId,
      entityType: 'garment_photo',
      entityId: photo.id,
      action: 'create',
      diff: { view: photo.view, sizeBytes: photo.sizeBytes, width: photo.width, height: photo.height },
      requestId: req.ctx.requestId,
    });
    created(req, res, { photo });
  }),
);

photoRouter.get(
  '/garments/:garmentId/photos',
  requireAuth,
  handler(async (req, res) => {
    const garment = await prisma.garment.findFirst({
      where: { id: req.params.garmentId, wardrobeId: req.ctx.wardrobeId, deletedAt: null },
    });
    if (!garment) throw new HttpError('NOT_FOUND', '衣物档案不存在');
    const photos = await prisma.garmentPhoto.findMany({
      where: { garmentId: garment.id, deletedAt: null },
      include: { annotations: { include: { part: true }, orderBy: { createdAt: 'asc' } } },
      orderBy: { createdAt: 'asc' },
    });
    const grouped: Record<string, typeof photos> = {};
    for (const photo of photos) {
      grouped[photo.view] = grouped[photo.view] ?? [];
      grouped[photo.view].push(photo);
    }
    ok(req, res, { photos, grouped });
  }),
);

photoRouter.patch(
  '/photos/:id',
  requireAuth,
  handler(async (req, res) => {
    const photo = await prisma.garmentPhoto.findFirst({
      where: { id: req.params.id, garment: { wardrobeId: req.ctx.wardrobeId }, deletedAt: null },
    });
    if (!photo) throw new HttpError('NOT_FOUND', '照片不存在');
    const body = parseBody(photoUpdateSchema, req.body);
    const updated = await prisma.garmentPhoto.update({
      where: { id: photo.id },
      data: {
        ...(body.view ? { view: body.view } : {}),
        ...(body.note !== undefined ? { note: body.note } : {}),
        ...(body.pairedPhotoId !== undefined ? { pairedPhotoId: body.pairedPhotoId } : {}),
        ...(body.capturedAt !== undefined
          ? { capturedAt: body.capturedAt ? parseDateOnly(body.capturedAt) : null }
          : {}),
      },
    });
    ok(req, res, { photo: updated });
  }),
);

photoRouter.delete(
  '/photos/:id',
  requireAuth,
  handler(async (req, res) => {
    const photo = await prisma.garmentPhoto.findFirst({
      where: { id: req.params.id, garment: { wardrobeId: req.ctx.wardrobeId }, deletedAt: null },
      include: { annotations: true },
    });
    if (!photo) throw new HttpError('NOT_FOUND', '照片不存在');
    const linked = photo.annotations.filter((a) => a.damageEventId || a.repairId || a.frozen);
    if (linked.length > 0) {
      throw new HttpError('PHOTO_IN_USE', '这张照片已经作为破损/修补证据被引用，不能删除；如需更换请先解绑标记');
    }
    await prisma.$transaction([
      prisma.photoAnnotation.deleteMany({ where: { photoId: photo.id } }),
      prisma.garmentPhoto.update({ where: { id: photo.id }, data: { deletedAt: new Date() } }),
    ]);
    await logActivity({
      wardrobeId: req.ctx.wardrobeId,
      actorId: req.ctx.userId,
      entityType: 'garment_photo',
      entityId: photo.id,
      action: 'delete',
      diff: { softDelete: true },
      requestId: req.ctx.requestId,
    });
    ok(req, res, { deleted: true });
  }),
);

photoRouter.get(
  '/photos/:id/annotations',
  requireAuth,
  handler(async (req, res) => {
    const photo = await prisma.garmentPhoto.findFirst({
      where: { id: req.params.id, garment: { wardrobeId: req.ctx.wardrobeId }, deletedAt: null },
    });
    if (!photo) throw new HttpError('NOT_FOUND', '照片不存在');
    const annotations = await prisma.photoAnnotation.findMany({
      where: { photoId: photo.id },
      include: { part: true, damageEvent: { include: { damageType: true } }, repair: { include: { stitch: true } } },
      orderBy: { createdAt: 'asc' },
    });
    ok(req, res, { annotations, photo });
  }),
);

photoRouter.post(
  '/photos/:id/annotations',
  requireAuth,
  handler(async (req, res) => {
    const photo = await prisma.garmentPhoto.findFirst({
      where: { id: req.params.id, garment: { wardrobeId: req.ctx.wardrobeId }, deletedAt: null },
    });
    if (!photo) throw new HttpError('NOT_FOUND', '照片不存在');
    const body = parseBody(annotationBatchSchema, req.body);

    const prepared = body.annotations.map((annotation) => normalizeAnnotation(annotation));
    const createdRows = await prisma.$transaction(
      prepared.map((annotation) =>
        prisma.photoAnnotation.create({
          data: {
            photoId: photo.id,
            garmentId: photo.garmentId,
            kind: annotation.kind,
            geometry: annotation.geometry as never,
            radius: annotation.radius ?? (annotation.kind === 'point' ? 0.012 : null),
            partId: annotation.partId ?? null,
            label: annotation.label ?? null,
            color: annotation.color ?? (annotation.damageEventId ? '#e8590c' : '#1d4ed8'),
            damageEventId: annotation.damageEventId ?? null,
            repairId: annotation.repairId ?? null,
            status: annotation.damageEventId || annotation.repairId ? 'linked' : 'draft',
            note: annotation.note ?? null,
            createdBy: req.ctx.userId,
          },
        }),
      ),
    );

    await logActivity({
      wardrobeId: req.ctx.wardrobeId,
      actorId: req.ctx.userId,
      entityType: 'photo_annotation',
      entityId: createdRows[0]?.id ?? photo.id,
      action: 'create',
      diff: { photoId: photo.id, count: createdRows.length },
      requestId: req.ctx.requestId,
    });
    created(req, res, {
      annotations: createdRows,
      draftCount: createdRows.filter((a) => a.status === 'draft').length,
    });
  }),
);

photoRouter.patch(
  '/annotations/:id',
  requireAuth,
  handler(async (req, res) => {
    const annotation = await prisma.photoAnnotation.findFirst({
      where: { id: req.params.id, garment: { wardrobeId: req.ctx.wardrobeId } },
    });
    if (!annotation) throw new HttpError('NOT_FOUND', '标记不存在');
    const body = parseBody(annotationBaseSchema.partial(), req.body);
    const normalized = body.kind && body.geometry ? normalizeAnnotation(body as AnnotationInput) : null;
    const updated = await prisma.photoAnnotation.update({
      where: { id: annotation.id },
      data: {
        ...(body.kind ? { kind: body.kind } : {}),
        ...(normalized ? { geometry: normalized.geometry as never } : {}),
        ...(body.radius !== undefined ? { radius: body.radius } : {}),
        ...(body.partId !== undefined ? { partId: body.partId } : {}),
        ...(body.label !== undefined ? { label: body.label } : {}),
        ...(body.color !== undefined ? { color: body.color } : {}),
        ...(body.note !== undefined ? { note: body.note } : {}),
        ...(body.damageEventId !== undefined || body.repairId !== undefined
          ? {
              damageEventId: body.damageEventId ?? null,
              repairId: body.repairId ?? null,
              status: body.damageEventId || body.repairId ? 'linked' : 'draft',
            }
          : {}),
      },
    });
    ok(req, res, { annotation: updated });
  }),
);

photoRouter.delete(
  '/annotations/:id',
  requireAuth,
  handler(async (req, res) => {
    const annotation = await prisma.photoAnnotation.findFirst({
      where: { id: req.params.id, garment: { wardrobeId: req.ctx.wardrobeId } },
    });
    if (!annotation) throw new HttpError('NOT_FOUND', '标记不存在');
    if (annotation.frozen) {
      // 已被破损事件冻结为证据：只能解绑，不能删除
      const updated = await prisma.photoAnnotation.update({
        where: { id: annotation.id },
        data: { damageEventId: null, status: 'draft', frozen: false },
      });
      ok(req, res, { annotation: updated, unfrozen: true });
      return;
    }
    await prisma.photoAnnotation.delete({ where: { id: annotation.id } });
    ok(req, res, { deleted: true });
  }),
);

photoRouter.post(
  '/annotations/:id/link',
  requireAuth,
  handler(async (req, res) => {
    const annotation = await prisma.photoAnnotation.findFirst({
      where: { id: req.params.id, garment: { wardrobeId: req.ctx.wardrobeId } },
    });
    if (!annotation) throw new HttpError('NOT_FOUND', '标记不存在');
    const body = parseBody(
      annotationBaseSchema.pick({ damageEventId: true, repairId: true, partId: true, label: true }).partial(),
      req.body,
    );
    if (!body.damageEventId && !body.repairId) {
      throw new HttpError('VALIDATION_FAILED', '请选择要关联的破损事件或修补记录');
    }
    if (body.damageEventId) {
      const damage = await prisma.damageEvent.findFirst({
        where: { id: body.damageEventId, garmentId: annotation.garmentId },
      });
      if (!damage) throw new HttpError('NOT_FOUND', '破损事件不存在或不属于这件衣物');
    }
    const updated = await prisma.photoAnnotation.update({
      where: { id: annotation.id },
      data: {
        damageEventId: body.damageEventId ?? annotation.damageEventId,
        repairId: body.repairId ?? annotation.repairId,
        partId: body.partId ?? annotation.partId,
        label: body.label ?? annotation.label,
        status: 'linked',
      },
    });
    ok(req, res, { annotation: updated });
  }),
);

/** 归一化几何 + 钳制 + 精度处理（项目文档 11.1），非法数据直接拒绝 */
function normalizeAnnotation(annotation: AnnotationInput) {
  const roundPoint = (p: { x: number; y: number }) => ({ x: roundCoord(p.x), y: roundCoord(p.y) });
  if (annotation.kind === 'point') {
    const parsed = pointGeometrySchema.parse(annotation.geometry);
    return { ...annotation, geometry: roundPoint(parsed) };
  }
  if (annotation.kind === 'rect') {
    const parsed = rectGeometrySchema.parse(annotation.geometry);
    return {
      ...annotation,
      geometry: {
        x: roundCoord(parsed.x),
        y: roundCoord(parsed.y),
        w: roundCoord(Math.min(parsed.w, 1 - parsed.x)),
        h: roundCoord(Math.min(parsed.h, 1 - parsed.y)),
      },
    };
  }
  const parsed = polylineGeometrySchema.parse(annotation.geometry);
  return { ...annotation, geometry: { points: parsed.points.map(roundPoint) } };
}
