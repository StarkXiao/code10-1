#!/usr/bin/env node
/**
 * 端到端闭环冒烟脚本（真实 HTTP 调用，不是 mock）：
 *   建档 → 传图 → 标记 → 登记破损 → 修补 → 用料扣库存 → 记变化 → 观察期 → 复检闭环
 *   → 穿着打点 → 复发 → 提醒 → 分析报告 → 导出 → 退役
 *
 * 用法：先启动服务，然后 node apps/server/scripts/smoke.mjs [baseUrl]
 */
import { createRequire } from 'node:module';

const BASE = process.argv[2] ?? process.env.SMOKE_BASE ?? 'http://localhost:3000';
const require = createRequire(import.meta.url);
const sharp = require('sharp');

let token = '';
const results = [];

async function api(path, { method = 'GET', body, form, expectOk = true } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}/api${path}`, { method, headers, body: payload });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (expectOk && !json.ok) {
    throw new Error(`${method} ${path} 失败：${res.status} ${JSON.stringify(json.error ?? json).slice(0, 300)}`);
  }
  return { status: res.status, json };
}

function step(name, detail) {
  results.push({ name, detail });
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
}

const today = new Date();
const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => iso(new Date(today.getTime() - n * 86_400_000));

console.log(`\n== 衣物修补日志 · 闭环冒烟测试 @ ${BASE} ==\n`);

// 1. 注册
const email = `smoke-${Date.now()}@example.com`;
const registered = await api('/auth/register', {
  method: 'POST',
  body: { email, password: 'mending123', displayName: '冒烟测试' },
});
token = registered.json.data.token;
step('注册 + 自动建衣橱 + 内置提醒规则', email);

// 2. 字典
const dict = (await api('/dictionary')).json.data;
assert(dict.stitches.length === 10, '针法字典应为 10 条');
assert(dict.damageTypes.length === 9, '破损类型应为 9 条');
const elbowRight = dict.partsFlat.find((p) => p.code === 'elbow_right');
const hole = dict.damageTypes.find((d) => d.code === 'hole');
const darning = dict.stitches.find((s) => s.code === 'darning_hand');
step(
  '读取字典',
  `针法 ${dict.stitches.length} / 破损 ${dict.damageTypes.length} / 材质 ${dict.materials.length} / 部位 ${dict.partsFlat.length}`,
);

// 3. 建档
const garmentRes = await api('/garments', {
  method: 'POST',
  body: {
    name: '灰色羊毛衫',
    category: 'sweater',
    materialPrimary: 'wool',
    knitOrWoven: 'knit',
    seasonTags: ['autumn', 'winter'],
    color: '灰色',
    purchaseDate: daysAgo(400),
    purchasePrice: 480,
    careNote: '30℃ 羊毛程序',
    storageLocation: '主卧衣柜第二层',
    // 首次穿着设在 25 天前：8 次穿着 → 月均约 9.7 次，落在「高频」档，便于验证频率维度
    firstWearDate: daysAgo(25),
  },
});
const garment = garmentRes.json.data.garment;
assert(/^G-\d{4}-\d{4}$/u.test(garment.code), `衣物编号格式异常：${garment.code}`);
step('建档', `${garment.code} ${garment.name}`);

// 4. 上传照片
const image = await sharp({
  create: { width: 1600, height: 1200, channels: 3, background: { r: 120, g: 120, b: 125 } },
}).jpeg({ quality: 88 }).toBuffer();
const form = new FormData();
form.append('file', new Blob([image], { type: 'image/jpeg' }), 'front.jpg');
form.append('view', 'front');
const photoRes = await api(`/garments/${garment.id}/photos`, { method: 'POST', form });
const photo = photoRes.json.data.photo;
assert(photo.width === 1600 && photo.height === 1200, '照片尺寸记录不正确');
assert(photo.mimeType === 'image/webp', '照片应被转成 webp');
step('上传照片', `${photo.width}×${photo.height} → webp ${Math.round(photo.sizeBytes / 1024)}KB`);

// 5. 照片标记
const annRes = await api(`/photos/${photo.id}/annotations`, {
  method: 'POST',
  body: {
    annotations: [
      { kind: 'point', geometry: { x: 0.41235, y: 0.66719 }, partId: elbowRight.id, label: '第一次破这里' },
    ],
  },
});
const annotation = annRes.json.data.annotations[0];
assert(annotation.status === 'draft', '未关联的标记应为 draft');
assert(annotation.geometry.x === 0.4123 || annotation.geometry.x === 0.4124, `坐标精度未归一：${annotation.geometry.x}`);
step('照片标记', `x=${annotation.geometry.x} y=${annotation.geometry.y}（归一化到 4 位小数）`);

// 6. 登记破损
const damageRes = await api('/damage-events', {
  method: 'POST',
  body: {
    garmentId: garment.id,
    damageTypeId: hole.id,
    severity: 'moderate',
    partId: elbowRight.id,
    detectedAt: daysAgo(60),
    detectedSource: 'self',
    description: '右肘磨出一个小洞，约黄豆大小',
    causeGuess: 'friction',
    measurableSize: { lengthMm: 8, widthMm: 5 },
    annotationIds: [annotation.id],
  },
});
const damage = damageRes.json.data.damage;
step('登记破损', `${damage.code} 状态=${damage.status}，标记已冻结为证据`);

const noLocation = await api('/damage-events', {
  method: 'POST',
  expectOk: false,
  body: { garmentId: garment.id, damageTypeId: hole.id, severity: 'minor', detectedAt: daysAgo(1) },
});
assert(noLocation.json.error.code === 'VALIDATION_FAILED', '未标记位置应当被拒绝');
step('校验：不标位置不能提交破损', '已按预期拦截');

// 7. 布料来源 + 库存
const fabricRes = await api('/fabric-sources', {
  method: 'POST',
  body: {
    name: '旧灰色羊毛袜拆的线',
    kind: 'donor_garment',
    materialPrimary: 'wool',
    color: '深灰',
    inventory: { unit: 'cm', initialAmount: 200 },
  },
});
const fabricSource = fabricRes.json.data.fabricSource;
step('登记布料来源', `${fabricSource.name}（初始 200cm）`);

// 8. 登记修补
const repairRes = await api('/repairs', {
  method: 'POST',
  body: {
    damageEventId: damage.id,
    executedBy: 'self',
    stitchId: darning.id,
    threadType: '羊毛线',
    threadColor: '深灰',
    durationMinutes: 45,
    cost: 5,
    startedAt: daysAgo(58),
    finishedAt: daysAgo(57),
    reuseOriginalFabric: false,
    resultRating: 'satisfied',
  },
});
const repair = repairRes.json.data.repair;
assert(repair.round === 1, '第一轮修补应为 round=1');
assert(repair.observationDays === 14, `自补默认观察期应为 14 天，实际 ${repair.observationDays}`);
step('登记修补', `第 ${repair.round} 轮 · 手工织补 · 观察期 ${repair.observationDays} 天`);

// 9. 用料扣库存
const materialRes = await api(`/repairs/${repair.id}/materials`, {
  method: 'POST',
  body: { fabricSourceId: fabricSource.id, amount: 30, note: '织补用线' },
});
assert(materialRes.json.data.inventory.remainingAmount === 170, '库存扣减不正确');
step('用料扣减库存', `200 → ${materialRes.json.data.inventory.remainingAmount}cm（含流水）`);

const overdraw = await api(`/repairs/${repair.id}/materials`, {
  method: 'POST',
  expectOk: false,
  body: { fabricSourceId: fabricSource.id, amount: 9999 },
});
assert(overdraw.json.error.code === 'INVENTORY_INSUFFICIENT', '超额用料应被拒绝');
step('校验：余料不足被拒绝', '已按预期拦截');

// 10. 修补后变化
await api(`/repairs/${repair.id}/change`, {
  method: 'PUT',
  body: {
    visibility: 'slight',
    colorMatch: 'close',
    dimensionChange: { lengthMm: 0, widthMm: 0 },
    stiffness: 'same',
    drapeChange: 'none',
    comfortNote: '穿上没有明显异物感，肘部活动正常',
    mobilityLimited: false,
    visibleFromOutside: false,
  },
});
step('记录修补后变化', '痕迹轻微 / 颜色接近 / 体感正常');

const observation = await api(`/repairs/${repair.id}/start-observation`, { method: 'POST', body: {} });
assert(observation.json.data.reminderCreated === true, '进入观察期应生成复检提醒');
step('进入观察期', `复检到期 ${observation.json.data.observationUntil.slice(0, 10)}，已生成提醒`);

// 11. 穿着打点（含幂等）
const wear1 = await api('/wear-logs', {
  method: 'POST',
  body: { garmentId: garment.id, wornOn: daysAgo(30), session: 'full_day', intensity: 'normal' },
});
assert(wear1.status === 201, '首次打点应返回 201');
const wearDup = await api('/wear-logs', {
  method: 'POST',
  body: { garmentId: garment.id, wornOn: daysAgo(30), session: 'full_day' },
});
assert(wearDup.json.meta.idempotent === true, '同日重复打点应幂等返回');
for (const d of [20, 15, 10, 5, 3, 2, 1]) {
  await api('/wear-logs', { method: 'POST', body: { garmentId: garment.id, wornOn: daysAgo(d), session: 'full_day' } });
}
const wearStats = (await api(`/garments/${garment.id}/wear-stats`)).json.data;
assert(wearStats.wearCount === 8, `穿着次数应为 8，实际 ${wearStats.wearCount}`);
assert(wearStats.frequencyBand === 'high', `应为高频，实际 ${wearStats.frequencyBand}`);
step('穿着打点', `8 次，月均 ${wearStats.perMonth} 次 → ${wearStats.frequencyBand}`);

// 12. 提醒：列表 + 一键执行复检
const reminderList = (await api('/reminders?scope=all&limit=50')).json.data.items;
const reviewReminder = reminderList.find((r) => r.actionKind === 'open_review_form');
assert(reviewReminder, '应存在复检提醒');
const reviewRes = await api(`/reminders/${reviewReminder.id}/action`, {
  method: 'POST',
  body: {
    review: {
      reviewedAt: daysAgo(30),
      verdict: 'good',
      reoccurred: false,
      verdictNote: '织补处平整，拉扯也没有松动',
      nextAction: 'close',
    },
  },
});
assert(reviewRes.json.data.outcome.damageStatus === 'resolved', '复检闭环后破损状态应为 resolved');
step('提醒一键执行复检', `结论 good → 修补 ${reviewRes.json.data.outcome.repairStatus} / 破损 ${reviewRes.json.data.outcome.damageStatus}`);

const afterReview = (await api('/reminders?scope=all&limit=50')).json.data.items.find(
  (r) => r.id === reviewReminder.id,
);
assert(afterReview.status === 'done', '提醒应已被闭环为 done');
assert(afterReview.resultRef?.reviewId, '提醒必须带 resultRef（不能假完成）');
step('提醒终态', `status=done，resultRef.reviewId=${String(afterReview.resultRef.reviewId).slice(0, 8)}…`);

// 13. 复发闭环
const damage2Res = await api('/damage-events', {
  method: 'POST',
  body: {
    garmentId: garment.id,
    damageTypeId: hole.id,
    severity: 'minor',
    partId: elbowRight.id,
    detectedAt: daysAgo(2),
    detectedSource: 'self',
    description: '同一个位置又开始磨薄',
    annotationIds: [],
    locationUnknown: true,
    locationNote: '沿用上次的标记位置，这次先不重复标记',
  },
});
const damage2 = damage2Res.json.data.damage;
const candidates = (await api(`/damage-events/${damage2.id}/recurrence-candidates`)).json.data.candidates;
assert(candidates.length >= 1, '应能匹配到复发候选');
const linkRes = await api(`/damage-events/${damage2.id}/link-recurrence`, {
  method: 'POST',
  body: { recurrenceOfId: damage.id },
});
assert(linkRes.json.data.damage.recurrenceIndex === 2, '复发序号应为 2');
step('复发识别 + 串链', `候选 ${candidates.length} 条，复发序号 2`);

const recurrenceReminders = (await api('/reminders?scope=all&limit=50')).json.data.items.filter((r) =>
  r.occurrenceKey.startsWith('recurrence:'),
);
assert(recurrenceReminders.length >= 1, '复发应触发预警提醒');
step('复发预警提醒', recurrenceReminders[0].title);

// 14. 分析报告
const byMaterial = (await api('/analytics/by-material')).json.data;
assert(byMaterial.rows.length >= 1, '材质分析应有数据');
const overview = (await api('/analytics/overview')).json.data;
step(
  '分析：材质维度',
  `羊毛：修补 ${byMaterial.rows[0].repairCount} 次，复修率 ${(byMaterial.rows[0].recurrenceRate * 100).toFixed(0)}%`,
);
step(
  '分析：总览',
  `衣物 ${overview.overview.garmentCount} 件 / 穿着 ${overview.overview.totalWearCount} 次 / 平均修补寿命 ${overview.overview.averageLifespanDays ?? '—'} 天（右删失 ${overview.overview.censoredLifespanCount} 条）`,
);
const bySeason = (await api('/analytics/by-season')).json.data;
const byFrequency = (await api('/analytics/by-frequency')).json.data;
step('分析：季节维度', bySeason.insights[0]?.text.slice(0, 70) ?? '—');
step('分析：频率维度', byFrequency.rows.map((r) => `${r.band}:${r.garmentCount}`).join(' '));
const stitchEffect = (await api('/analytics/stitch-effectiveness')).json.data;
step('分析：针法效果榜', `${stitchEffect.rows.length} 个组合（需复发样本才有效）`);

// 15. 终身档案 + 导出
const lifetime = (await api(`/garments/${garment.id}/lifetime-report`)).json.data;
assert(lifetime.report.health.score >= 0 && lifetime.report.health.score <= 100, '健康分应在 0-100');
step('终身档案', `健康分 ${lifetime.report.health.score}，每穿成本 ${lifetime.report.costPerWear} 元`);

for (const dataset of ['garments', 'damages', 'repairs', 'wears']) {
  const csv = await fetch(`${BASE}/api/export/wardrobe.csv?dataset=${dataset}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert(csv.status === 200, `CSV 导出失败：${dataset}`);
}
step('CSV 导出', 'garments / damages / repairs / wears 全部可用');

const md = await fetch(`${BASE}/api/export/garments/${garment.id}.md`, {
  headers: { authorization: `Bearer ${token}` },
});
const mdText = await md.text();
assert(mdText.includes('灰色羊毛衫'), 'Markdown 档案应包含衣物名');
step('Markdown 档案导出', `${mdText.split('\n').length} 行`);

const worksheet = await fetch(`${BASE}/api/print/repair-worksheet/${damage.id}?token=${encodeURIComponent(token)}`);
assert(worksheet.status === 200, '修补工单打印视图不可用');
step('修补工单打印视图', '可直接打印 / 另存为 PDF');

const backup = await fetch(`${BASE}/api/export/backup`, { headers: { authorization: `Bearer ${token}` } });
const backupBuf = Buffer.from(await backup.arrayBuffer());
assert(backupBuf.subarray(0, 2).toString() === 'PK', '备份应为 zip');
step('全量备份', `${Math.round(backupBuf.length / 1024)}KB（db + 图片 + JSON）`);

// 16. 退役闭环
const retireRes = await api(`/garments/${garment.id}/retire`, {
  method: 'POST',
  body: { disposition: 'upcycle', dispositionNote: '拆线改成手套' },
});
assert(retireRes.json.data.garment.status === 'retired', '退役后状态应为 retired');
const openAfterRetire = (await api('/reminders?scope=all&limit=50')).json.data.items.filter((r) =>
  ['pending', 'notified'].includes(r.status),
);
step('退役 + 待办清理', `退役成功，剩余未处理提醒 ${openAfterRetire.length} 条`);

console.log(`\n== 全部通过：${results.length} 项 ==\n`);
