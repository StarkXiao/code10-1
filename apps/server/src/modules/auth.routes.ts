import { Router } from 'express';
import { loginSchema, profileUpdateSchema, registerSchema } from '@gml/shared';
import { hashPassword, signToken, verifyPassword } from '../lib/auth.js';
import { HttpError } from '../lib/errors.js';
import { created, handler, ok, parseBody } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { randomInviteCode } from '../lib/ids.js';
import { requireAuth } from '../middleware/auth.js';
import { ensureBuiltinRules } from '../services/rules/engine.js';

export const authRouter = Router();

authRouter.post(
  '/register',
  handler(async (req, res) => {
    const body = parseBody(registerSchema, req.body);
    const email = body.email.toLowerCase().trim();
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) throw new HttpError('CONFLICT', '这个邮箱已经注册过了，直接登录即可');

    const passwordHash = await hashPassword(body.password);
    const user = await prisma.user.create({
      data: { email, passwordHash, displayName: body.displayName.trim() },
    });
    const wardrobe = await prisma.wardrobe.create({
      data: {
        ownerId: user.id,
        name: `${user.displayName}的衣橱`,
        inviteCode: randomInviteCode(),
      },
    });
    await prisma.wardrobeMember.create({
      data: { wardrobeId: wardrobe.id, userId: user.id, role: 'owner' },
    });
    // 开箱即用的内置提醒规则（项目文档 12.2）
    await ensureBuiltinRules(wardrobe.id);

    const token = signToken({ sub: user.id, wardrobeId: wardrobe.id, email: user.email });
    created(req, res, {
      token,
      user: publicUser(user),
      wardrobe: publicWardrobe(wardrobe),
    });
  }),
);

authRouter.post(
  '/login',
  handler(async (req, res) => {
    const body = parseBody(loginSchema, req.body);
    const email = body.email.toLowerCase().trim();
    const user = await prisma.user.findUnique({
      where: { email },
      include: { memberships: { include: { wardrobe: true } } },
    });
    if (!user) throw new HttpError('INVALID_CREDENTIALS', '邮箱或密码不正确');
    const valid = await verifyPassword(body.password, user.passwordHash);
    if (!valid) throw new HttpError('INVALID_CREDENTIALS', '邮箱或密码不正确');

    let wardrobe = user.memberships.find((m) => m.role === 'owner')?.wardrobe ?? user.memberships[0]?.wardrobe;
    if (!wardrobe) {
      wardrobe = await prisma.wardrobe.create({
        data: { ownerId: user.id, name: `${user.displayName}的衣橱`, inviteCode: randomInviteCode() },
      });
      await prisma.wardrobeMember.create({ data: { wardrobeId: wardrobe.id, userId: user.id, role: 'owner' } });
    }
    await ensureBuiltinRules(wardrobe.id);

    const token = signToken({ sub: user.id, wardrobeId: wardrobe.id, email: user.email });
    ok(req, res, { token, user: publicUser(user), wardrobe: publicWardrobe(wardrobe) });
  }),
);

authRouter.post(
  '/logout',
  handler(async (req, res) => {
    // JWT 无状态：前端清 token 即可。这里保留端点用于审计与后续黑名单扩展。
    ok(req, res, { loggedOut: true });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  handler(async (req, res) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.ctx.userId } });
    const wardrobe = await prisma.wardrobe.findUniqueOrThrow({
      where: { id: req.ctx.wardrobeId },
      include: { members: true },
    });
    ok(req, res, { user: publicUser(user), wardrobe: publicWardrobe(wardrobe, wardrobe.members.length) });
  }),
);

authRouter.patch(
  '/me',
  requireAuth,
  handler(async (req, res) => {
    const body = parseBody(profileUpdateSchema, req.body);
    const user = await prisma.user.update({ where: { id: req.ctx.userId }, data: body });
    ok(req, res, { user: publicUser(user) });
  }),
);

function publicUser(user: {
  id: string;
  email: string;
  displayName: string;
  timezone: string;
  reminderHour: number;
}) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    timezone: user.timezone,
    reminderHour: user.reminderHour,
  };
}

function publicWardrobe(
  wardrobe: { id: string; name: string; inviteCode: string; defaultReminderHour: number },
  memberCount = 1,
) {
  return {
    id: wardrobe.id,
    name: wardrobe.name,
    inviteCode: wardrobe.inviteCode,
    defaultReminderHour: wardrobe.defaultReminderHour,
    memberCount,
  };
}
