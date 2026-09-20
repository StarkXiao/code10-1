import { Router } from 'express';
import {
  fabricSourceSchema,
  fabricSourceUpdateSchema,
  inventoryAdjustSchema,
  inventoryRestockSchema,
} from '@gml/shared';
import { HttpError } from '../lib/errors.js';
import { created, handler, ok, parseBody } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { logActivity } from '../lib/activity.js';
import { parseDateOnly } from '../lib/date.js';
import { requireAuth } from '../middleware/auth.js';
import { computeAllGarmentStats, loadDataset } from '../services/stats.js';

export const fabricRouter = Router();
fabricRouter.use(requireAuth);

fabricRouter.get(
  '/',
  handler(async (req, res) => {
    const sources = await prisma.fabricSource.findMany({
      where: { wardrobeId: req.ctx.wardrobeId },
      include: {
        inventory: true,
        donorGarment: { select: { id: true, code: true, name: true } },
        _count: { select: { materials: true } },
      },
      orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
    });

    const inventoryIds = sources.map((s) => s.inventory?.id).filter((id): id is string => !!id);
    const consumption = inventoryIds.length
      ? await prisma.inventoryTxn.groupBy({
          by: ['inventoryId', 'direction'],
          where: { inventoryId: { in: inventoryIds } },
          _sum: { amount: true },
        })
      : [];

    ok(req, res, {
      items: sources.map((source) => {
        const consumed =
          consumption.find((c) => c.inventoryId === source.inventory?.id && c.direction === 'consume')?._sum.amount ?? 0;
        const restocked =
          consumption.find((c) => c.inventoryId === source.inventory?.id && c.direction === 'restock')?._sum.amount ?? 0;
        return {
          id: source.id,
          name: source.name,
          kind: source.kind,
          materialPrimary: source.materialPrimary,
          color: source.color,
          compositionNote: source.compositionNote,
          price: source.price?.toString() ?? null,
          purchaseDate: source.purchaseDate,
          purchaseLocation: source.purchaseLocation,
          isActive: source.isActive,
          donorGarment: source.donorGarment,
          usageCount: source._count.materials,
          inventory: source.inventory
            ? {
                id: source.inventory.id,
                unit: source.inventory.unit,
                initialAmount: source.inventory.initialAmount,
                remainingAmount: source.inventory.remainingAmount,
                lowStockThreshold: source.inventory.lowStockThreshold,
                consumed,
                restocked,
                isLow: source.inventory.remainingAmount <= source.inventory.lowStockThreshold,
              }
            : null,
        };
      }),
    });
  }),
);

fabricRouter.post(
  '/',
  handler(async (req, res) => {
    const body = parseBody(fabricSourceSchema, req.body);
    if (body.donorGarmentId) {
      const donor = await prisma.garment.findFirst({
        where: { id: body.donorGarmentId, wardrobeId: req.ctx.wardrobeId },
      });
      if (!donor) throw new HttpError('NOT_FOUND', '作为布料来源的衣物不存在');
    }
    const source = await prisma.$transaction(async (tx) => {
      const record = await tx.fabricSource.create({
        data: {
          wardrobeId: req.ctx.wardrobeId,
          name: body.name,
          kind: body.kind,
          donorGarmentId: body.donorGarmentId ?? null,
          materialPrimary: body.materialPrimary,
          color: body.color ?? null,
          compositionNote: body.compositionNote ?? null,
          price: body.price ?? null,
          purchaseDate: body.purchaseDate ? parseDateOnly(body.purchaseDate) : null,
          purchaseLocation: body.purchaseLocation ?? null,
        },
      });
      if (body.inventory) {
        const threshold = body.inventory.lowStockThreshold ?? body.inventory.initialAmount * 0.15;
        const inventory = await tx.fabricInventory.create({
          data: {
            fabricSourceId: record.id,
            unit: body.inventory.unit,
            initialAmount: body.inventory.initialAmount,
            remainingAmount: body.inventory.initialAmount,
            lowStockThreshold: Math.round(threshold * 100) / 100,
          },
        });
        await tx.inventoryTxn.create({
          data: {
            inventoryId: inventory.id,
            direction: 'restock',
            amount: body.inventory.initialAmount,
            reason: '建立库存',
            createdBy: req.ctx.userId,
          },
        });
      }
      return record;
    });
    await logActivity({
      wardrobeId: req.ctx.wardrobeId,
      actorId: req.ctx.userId,
      entityType: 'fabric_source',
      entityId: source.id,
      action: 'create',
      diff: { name: source.name, kind: source.kind },
      requestId: req.ctx.requestId,
    });
    created(req, res, { fabricSource: source });
  }),
);

fabricRouter.patch(
  '/:id',
  handler(async (req, res) => {
    const source = await findSourceOrThrow(req.params.id, req.ctx.wardrobeId);
    const body = parseBody(fabricSourceUpdateSchema, req.body);
    const updated = await prisma.fabricSource.update({
      where: { id: source.id },
      data: {
        ...(body.name ? { name: body.name } : {}),
        ...(body.kind ? { kind: body.kind } : {}),
        ...(body.materialPrimary ? { materialPrimary: body.materialPrimary } : {}),
        ...(body.color !== undefined ? { color: body.color } : {}),
        ...(body.compositionNote !== undefined ? { compositionNote: body.compositionNote } : {}),
        ...(body.price !== undefined ? { price: body.price } : {}),
        ...(body.purchaseLocation !== undefined ? { purchaseLocation: body.purchaseLocation } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      },
    });
    ok(req, res, { fabricSource: updated });
  }),
);

fabricRouter.post(
  '/:id/restock',
  handler(async (req, res) => {
    const source = await findSourceOrThrow(req.params.id, req.ctx.wardrobeId);
    const body = parseBody(inventoryRestockSchema, req.body);
    const inventory = await prisma.fabricInventory.findUnique({ where: { fabricSourceId: source.id } });
    if (!inventory) throw new HttpError('VALIDATION_FAILED', '这条来源还没有库存记录');
    const updated = await prisma.$transaction(async (tx) => {
      const record = await tx.fabricInventory.update({
        where: { id: inventory.id },
        data: { remainingAmount: { increment: body.amount } },
      });
      await tx.inventoryTxn.create({
        data: {
          inventoryId: inventory.id,
          direction: 'restock',
          amount: body.amount,
          reason: body.note ?? '补货',
          createdBy: req.ctx.userId,
        },
      });
      return record;
    });

    // 补货后关闭低库存提醒（闭环）
    await prisma.reminder.updateMany({
      where: {
        subjectType: 'fabric_inventory',
        subjectId: inventory.id,
        status: { in: ['pending', 'notified'] },
      },
      data: { status: 'done', handledAt: new Date(), resultRef: { restocked: body.amount } as never },
    });
    ok(req, res, { inventory: updated });
  }),
);

fabricRouter.post(
  '/:id/adjust',
  handler(async (req, res) => {
    const source = await findSourceOrThrow(req.params.id, req.ctx.wardrobeId);
    const body = parseBody(inventoryAdjustSchema, req.body);
    const inventory = await prisma.fabricInventory.findUnique({ where: { fabricSourceId: source.id } });
    if (!inventory) throw new HttpError('VALIDATION_FAILED', '这条来源还没有库存记录');
    const delta = body.amount - inventory.remainingAmount;
    const updated = await prisma.$transaction(async (tx) => {
      const record = await tx.fabricInventory.update({
        where: { id: inventory.id },
        data: { remainingAmount: body.amount },
      });
      await tx.inventoryTxn.create({
        data: {
          inventoryId: inventory.id,
          direction: 'adjust',
          amount: delta,
          reason: body.reason,
          createdBy: req.ctx.userId,
        },
      });
      return record;
    });
    ok(req, res, { inventory: updated, delta });
  }),
);

fabricRouter.get(
  '/:id/txns',
  handler(async (req, res) => {
    const source = await findSourceOrThrow(req.params.id, req.ctx.wardrobeId);
    const inventory = await prisma.fabricInventory.findUnique({ where: { fabricSourceId: source.id } });
    if (!inventory) throw new HttpError('NOT_FOUND', '这条来源还没有库存记录');
    const txns = await prisma.inventoryTxn.findMany({
      where: { inventoryId: inventory.id },
      include: { repair: { include: { damageEvent: { include: { garment: { select: { name: true, code: true } } } } } } },
      orderBy: { createdAt: 'desc' },
    });
    ok(req, res, { inventory, txns });
  }),
);

fabricRouter.get(
  '/:id/usage',
  handler(async (req, res) => {
    const source = await findSourceOrThrow(req.params.id, req.ctx.wardrobeId);
    const materials = await prisma.repairMaterial.findMany({
      where: { fabricSourceId: source.id },
      include: {
        repair: {
          include: {
            damageEvent: { include: { garment: { select: { id: true, name: true, code: true, materialPrimary: true } } } },
            stitch: true,
            reviews: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const dataset = await loadDataset(req.ctx.wardrobeId, { includeRetired: true });
    const stats = computeAllGarmentStats(dataset);
    const samples = [...stats.values()]
      .flatMap((s) => s.lifespanSamples)
      .filter((sample) => materials.some((m) => m.repairId === sample.repairId));
    const observed = samples.filter((s) => !s.censored);

    ok(req, res, {
      fabricSource: { id: source.id, name: source.name, kind: source.kind },
      usages: materials.map((m) => ({
        repairId: m.repairId,
        amount: m.amount,
        unit: m.unit,
        garment: m.repair.damageEvent.garment,
        stitch: m.repair.stitch.name,
        finishedAt: m.repair.finishedAt,
        verdict: m.repair.reviews.at(-1)?.verdict ?? null,
      })),
      effectiveness: {
        sampleCount: samples.length,
        observedCount: observed.length,
        censoredCount: samples.length - observed.length,
        averageLifespanDays: observed.length
          ? Math.round((observed.reduce((sum, s) => sum + s.days, 0) / observed.length) * 100) / 100
          : null,
      },
    });
  }),
);

async function findSourceOrThrow(id: string, wardrobeId: string) {
  const source = await prisma.fabricSource.findFirst({ where: { id, wardrobeId } });
  if (!source) throw new HttpError('NOT_FOUND', '布料来源不存在');
  return source;
}
