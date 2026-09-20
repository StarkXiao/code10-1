/**
 * 字典基线数据（项目文档 14 章）。
 *
 * 重要：这里只写"字典类"数据（针法 / 破损类型 / 材质 / 护理规则 / 部位树），
 * 不写任何虚构的衣物、破损、修补记录 —— 这个项目不做演示数据。
 * 脚本幂等，可以反复执行。
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const STITCHES = [
  {
    code: 'invisible_stitch',
    name: '藏针缝',
    suitableFabrics: ['woven', 'knit'],
    suitableDamageTypes: ['seam_open'],
    difficulty: 'easy',
    typicalMinutes: 10,
    requiresMachine: false,
    description: '从布料夹层走针，表面几乎看不到线迹，适合接缝开裂。先把两侧对齐，从内侧入针，左右交替挑 1-2 mm 的布丝，最后收紧藏线头。',
  },
  {
    code: 'backstitch',
    name: '回针缝',
    suitableFabrics: ['woven', 'denim', 'leather'],
    suitableDamageTypes: ['tear', 'seam_open'],
    difficulty: 'easy',
    typicalMinutes: 15,
    requiresMachine: false,
    description: '每针回退半针再前进，缝线强度接近机缝，适合受力部位的撕裂与开线。',
  },
  {
    code: 'running_stitch',
    name: '平针缝',
    suitableFabrics: ['woven'],
    suitableDamageTypes: ['seam_open'],
    difficulty: 'easy',
    typicalMinutes: 8,
    requiresMachine: false,
    description: '最简单的一上一下走针，适合临时固定或受力很小的位置。',
  },
  {
    code: 'overcast',
    name: '锁边缝',
    suitableFabrics: ['woven', 'knit'],
    suitableDamageTypes: ['thinning', 'tear'],
    difficulty: 'medium',
    typicalMinutes: 20,
    requiresMachine: false,
    description: '沿布边斜向绕缝，包住毛边防止继续脱散。磨薄区域建议先锁边再考虑加固衬布。',
  },
  {
    code: 'darning_hand',
    name: '织补（手工）',
    suitableFabrics: ['knit', 'wool', 'cashmere'],
    suitableDamageTypes: ['hole', 'thinning'],
    difficulty: 'hard',
    typicalMinutes: 45,
    requiresMachine: false,
    description: '顺着针织线圈的走向补出缺失的线圈，先纵向搭线再横向穿插，可以保留弹性。羊毛与羊绒首选此法。',
  },
  {
    code: 'darning_machine',
    name: '织补（机器）',
    suitableFabrics: ['knit'],
    suitableDamageTypes: ['hole'],
    difficulty: 'medium',
    typicalMinutes: 10,
    requiresMachine: true,
    description: '用缝纫机的织补压脚往复缝合，速度快但痕迹比手工织补明显。',
  },
  {
    code: 'patch_applique',
    name: '贴布补丁',
    suitableFabrics: ['woven', 'denim', 'knit', 'jacket'],
    suitableDamageTypes: ['hole', 'tear', 'thinning'],
    difficulty: 'easy',
    typicalMinutes: 25,
    requiresMachine: false,
    description: '裁一块同色或撞色补丁布覆盖破损区，四周用回针或平针缝合。牛仔与工装首选，兼顾加固与装饰。',
  },
  {
    code: 'fusible',
    name: '熨烫贴合补',
    suitableFabrics: ['woven'],
    suitableDamageTypes: ['hole', 'tear'],
    difficulty: 'easy',
    typicalMinutes: 5,
    requiresMachine: false,
    description: '用热熔衬/无痕贴熨烫粘合，最快但最不耐洗，只建议作为临时处理或配合缝线使用。针织类不要用。',
  },
  {
    code: 'serging',
    name: '机器锁边',
    suitableFabrics: ['woven'],
    suitableDamageTypes: ['thinning', 'tear'],
    difficulty: 'medium',
    typicalMinutes: 12,
    requiresMachine: true,
    description: '包缝机沿边包缝，边缘牢固整齐，适合磨薄或脱线的下摆、裤脚。',
  },
  {
    code: 'part_replacement',
    name: '换件替换',
    suitableFabrics: ['woven', 'knit', 'leather'],
    suitableDamageTypes: ['zipper', 'button'],
    difficulty: 'medium',
    typicalMinutes: 40,
    requiresMachine: true,
    description: '整体更换拉链、纽扣、衬里等部件。记录新配件的尺寸与来源，方便下次再换时直接复用。',
  },
];

const DAMAGE_TYPES = [
  { code: 'hole', name: '破洞', defaultSeverity: 'moderate', suggestedStitchCodes: ['darning_hand', 'patch_applique', 'darning_machine'], typicalCauses: ['摩擦', '勾挂', '虫蛀'] },
  { code: 'seam_open', name: '开线', defaultSeverity: 'minor', suggestedStitchCodes: ['invisible_stitch', 'backstitch'], typicalCauses: ['缝合强度不足', '牵扯受力'] },
  { code: 'thinning', name: '磨薄', defaultSeverity: 'minor', suggestedStitchCodes: ['overcast', 'patch_applique'], typicalCauses: ['长期摩擦'] },
  { code: 'tear', name: '撕裂', defaultSeverity: 'severe', suggestedStitchCodes: ['backstitch', 'patch_applique'], typicalCauses: ['受力', '勾挂'] },
  { code: 'zipper', name: '拉链损坏', defaultSeverity: 'moderate', suggestedStitchCodes: ['part_replacement'], typicalCauses: ['拉齿错位', '滑牙'] },
  { code: 'button', name: '纽扣脱落', defaultSeverity: 'minor', suggestedStitchCodes: ['part_replacement', 'backstitch'], typicalCauses: ['缝线松动'] },
  { code: 'stain', name: '染色', defaultSeverity: 'minor', suggestedStitchCodes: [], typicalCauses: ['洗涤串色', '沾染'] },
  { code: 'shrink_deform', name: '缩水变形', defaultSeverity: 'severe', suggestedStitchCodes: [], typicalCauses: ['洗护不当', '高温烘干'] },
  { code: 'pilling', name: '起球', defaultSeverity: 'minor', suggestedStitchCodes: [], typicalCauses: ['摩擦', '纤维短'] },
];

const MATERIALS = [
  { code: 'cotton', name: '棉', durabilityScore: 4, washAdvice: '40℃ 以下，可机洗，勿高温烘干', dryAdvice: '平铺晾干', typicalWeakPoints: ['腋下', '肘部'] },
  { code: 'wool', name: '羊毛', durabilityScore: 3, washAdvice: '30℃ 羊毛程序或手洗，勿搓揉', dryAdvice: '平铺阴干，勿烘干', typicalWeakPoints: ['肘部', '袖口', '后腰'] },
  { code: 'cashmere', name: '羊绒', durabilityScore: 2, washAdvice: '冷水手洗或干洗', dryAdvice: '平铺阴干', typicalWeakPoints: ['肘部', '下摆'] },
  { code: 'linen', name: '亚麻', durabilityScore: 3, washAdvice: '30℃ 轻柔', dryAdvice: '阴干后低温熨烫', typicalWeakPoints: ['折痕处', '缝合处'] },
  { code: 'silk', name: '真丝', durabilityScore: 2, washAdvice: '干洗或冷水手洗，中性洗涤剂', dryAdvice: '阴干，勿拧勿晒', typicalWeakPoints: ['腋下', '领口'] },
  { code: 'polyester', name: '涤纶', durabilityScore: 5, washAdvice: '40℃ 机洗', dryAdvice: '低温烘干', typicalWeakPoints: ['缝合线处', '起球点'] },
  { code: 'nylon', name: '锦纶', durabilityScore: 5, washAdvice: '40℃ 机洗', dryAdvice: '阴干', typicalWeakPoints: ['拉链周边'] },
  { code: 'denim', name: '牛仔', durabilityScore: 5, washAdvice: '冷水反面洗，尽量少洗', dryAdvice: '阴干，避免暴晒', typicalWeakPoints: ['膝盖', '裆部', '后袋角'] },
  { code: 'leather', name: '皮革', durabilityScore: 3, washAdvice: '不可水洗，专业护理', dryAdvice: '阴凉通风处', typicalWeakPoints: ['肘部', '领口', '折痕'] },
  { code: 'blend', name: '混纺', durabilityScore: 3, washAdvice: '按主纤维处理', dryAdvice: '按主纤维处理', typicalWeakPoints: ['随主纤维'] },
  { code: 'other', name: '其他', durabilityScore: 3, washAdvice: '参照洗标', dryAdvice: '参照洗标', typicalWeakPoints: [] },
];

const CARE_RULES = [
  { materialCode: 'cotton', wearCountBeforeWash: 1, checkIntervalDays: 60, seasonalCheckMonths: [3, 11], avoid: ['高温烘干'] },
  { materialCode: 'wool', wearCountBeforeWash: 3, checkIntervalDays: 30, seasonalCheckMonths: [3, 11], avoid: ['烘干', '漂白', '搓揉'] },
  { materialCode: 'cashmere', wearCountBeforeWash: 2, checkIntervalDays: 30, seasonalCheckMonths: [3, 11], avoid: ['烘干', '悬挂收纳'] },
  { materialCode: 'linen', wearCountBeforeWash: 2, checkIntervalDays: 60, seasonalCheckMonths: [3, 11], avoid: ['强力拧干'] },
  { materialCode: 'silk', wearCountBeforeWash: 2, checkIntervalDays: 60, seasonalCheckMonths: [3, 11], avoid: ['碱性洗涤剂', '暴晒', '拧绞'] },
  { materialCode: 'polyester', wearCountBeforeWash: 3, checkIntervalDays: 90, seasonalCheckMonths: [3, 11], avoid: ['高温熨烫'] },
  { materialCode: 'nylon', wearCountBeforeWash: 3, checkIntervalDays: 90, seasonalCheckMonths: [3, 11], avoid: ['高温'] },
  { materialCode: 'denim', wearCountBeforeWash: 5, checkIntervalDays: 90, seasonalCheckMonths: [3, 11], avoid: ['频繁洗涤', '暴晒'] },
  { materialCode: 'leather', wearCountBeforeWash: 10, checkIntervalDays: 90, seasonalCheckMonths: [3, 11], avoid: ['水洗', '暴晒'] },
  { materialCode: 'blend', wearCountBeforeWash: 3, checkIntervalDays: 60, seasonalCheckMonths: [3, 11], avoid: ['按主纤维处理'] },
  { materialCode: 'other', wearCountBeforeWash: 3, checkIntervalDays: 60, seasonalCheckMonths: [3, 11], avoid: [] },
];

const PARTS: Array<{ code: string; name: string; parent?: string; category?: string; sortOrder: number }> = [
  { code: 'torso', name: '躯干', sortOrder: 10 },
  { code: 'front_placket', name: '前襟', parent: 'torso', sortOrder: 11 },
  { code: 'back', name: '后背', parent: 'torso', sortOrder: 12 },
  { code: 'lower_back', name: '后腰', parent: 'torso', sortOrder: 13 },
  { code: 'hem', name: '下摆', parent: 'torso', sortOrder: 14 },
  { code: 'side_seam', name: '侧缝', parent: 'torso', sortOrder: 15 },
  { code: 'collar', name: '领口', parent: 'torso', sortOrder: 16 },
  { code: 'hood', name: '帽子', parent: 'torso', sortOrder: 17 },
  { code: 'shoulder', name: '肩部', parent: 'torso', sortOrder: 18 },
  { code: 'sleeve_left', name: '左袖', sortOrder: 20 },
  { code: 'upper_arm_left', name: '左上臂', parent: 'sleeve_left', sortOrder: 21 },
  { code: 'elbow_left', name: '左肘', parent: 'sleeve_left', sortOrder: 22 },
  { code: 'forearm_left', name: '左小臂', parent: 'sleeve_left', sortOrder: 23 },
  { code: 'cuff_left', name: '左袖口', parent: 'sleeve_left', sortOrder: 24 },
  { code: 'armhole_left', name: '左袖窝', parent: 'sleeve_left', sortOrder: 25 },
  { code: 'sleeve_right', name: '右袖', sortOrder: 30 },
  { code: 'upper_arm_right', name: '右上臂', parent: 'sleeve_right', sortOrder: 31 },
  { code: 'elbow_right', name: '右肘', parent: 'sleeve_right', sortOrder: 32 },
  { code: 'forearm_right', name: '右小臂', parent: 'sleeve_right', sortOrder: 33 },
  { code: 'cuff_right', name: '右袖口', parent: 'sleeve_right', sortOrder: 34 },
  { code: 'armhole_right', name: '右袖窝', parent: 'sleeve_right', sortOrder: 35 },
  { code: 'lower_body', name: '下装', sortOrder: 40 },
  { code: 'waistband', name: '腰头', parent: 'lower_body', sortOrder: 41 },
  { code: 'crotch', name: '裆部', parent: 'lower_body', sortOrder: 42 },
  { code: 'seat', name: '臀部', parent: 'lower_body', sortOrder: 43 },
  { code: 'leg_left', name: '左腿', parent: 'lower_body', sortOrder: 44 },
  { code: 'thigh_left', name: '左大腿', parent: 'leg_left', sortOrder: 45 },
  { code: 'knee_left', name: '左膝盖', parent: 'leg_left', sortOrder: 46 },
  { code: 'calf_left', name: '左小腿', parent: 'leg_left', sortOrder: 47 },
  { code: 'hem_left', name: '左裤脚', parent: 'leg_left', sortOrder: 48 },
  { code: 'leg_right', name: '右腿', parent: 'lower_body', sortOrder: 50 },
  { code: 'thigh_right', name: '右大腿', parent: 'leg_right', sortOrder: 51 },
  { code: 'knee_right', name: '右膝盖', parent: 'leg_right', sortOrder: 52 },
  { code: 'calf_right', name: '右小腿', parent: 'leg_right', sortOrder: 53 },
  { code: 'hem_right', name: '右裤脚', parent: 'leg_right', sortOrder: 54 },
  { code: 'accessory', name: '配饰', sortOrder: 60 },
  { code: 'zipper', name: '拉链', parent: 'accessory', sortOrder: 61 },
  { code: 'button_area', name: '纽扣', parent: 'accessory', sortOrder: 62 },
  { code: 'pocket', name: '口袋', parent: 'accessory', sortOrder: 63 },
  { code: 'lining', name: '内衬', parent: 'accessory', sortOrder: 64 },
  { code: 'care_label', name: '洗标', parent: 'accessory', sortOrder: 65 },
  { code: 'heel', name: '袜跟', parent: 'lower_body', category: 'socks', sortOrder: 70 },
  { code: 'toe', name: '袜尖', parent: 'lower_body', category: 'socks', sortOrder: 71 },
  { code: 'sole', name: '鞋底', sortOrder: 80, category: 'shoes' },
  { code: 'upper', name: '鞋面', sortOrder: 81, category: 'shoes' },
];

async function main() {
  console.log('[seed] 写入字典基线数据（幂等，可重复执行）');

  for (const stitch of STITCHES) {
    await prisma.stitch.upsert({
      where: { code: stitch.code },
      create: { ...stitch, isBuiltin: true },
      update: { ...stitch, isBuiltin: true },
    });
  }
  console.log(`[seed] 针法 ${STITCHES.length} 条`);

  for (const damageType of DAMAGE_TYPES) {
    await prisma.damageType.upsert({
      where: { code: damageType.code },
      create: { ...damageType, isBuiltin: true },
      update: { ...damageType, isBuiltin: true },
    });
  }
  console.log(`[seed] 破损类型 ${DAMAGE_TYPES.length} 条`);

  for (const material of MATERIALS) {
    await prisma.material.upsert({
      where: { code: material.code },
      create: { ...material, isBuiltin: true },
      update: { ...material, isBuiltin: true },
    });
  }
  console.log(`[seed] 材质 ${MATERIALS.length} 条`);

  for (const rule of CARE_RULES) {
    await prisma.careRule.upsert({
      where: { materialCode: rule.materialCode },
      create: { ...rule, observationDaysSelf: 14, observationDaysShop: 7 },
      update: { ...rule },
    });
  }
  console.log(`[seed] 护理规则 ${CARE_RULES.length} 条`);

  // 部位树：先建父级，再挂子级
  for (const part of PARTS.filter((p) => !p.parent)) {
    await prisma.part.upsert({
      where: { code: part.code },
      create: {
        code: part.code,
        name: part.name,
        category: part.category ?? null,
        sortOrder: part.sortOrder,
        isBuiltin: true,
      },
      update: { name: part.name, sortOrder: part.sortOrder, category: part.category ?? null },
    });
  }
  for (const part of PARTS.filter((p) => p.parent)) {
    const parent = await prisma.part.findUnique({ where: { code: part.parent! } });
    await prisma.part.upsert({
      where: { code: part.code },
      create: {
        code: part.code,
        name: part.name,
        parentId: parent?.id ?? null,
        category: part.category ?? null,
        sortOrder: part.sortOrder,
        isBuiltin: true,
      },
      update: { name: part.name, parentId: parent?.id ?? null, sortOrder: part.sortOrder },
    });
  }
  console.log(`[seed] 部位 ${PARTS.length} 条`);

  const [stitchCount, damageTypeCount, materialCount, partCount] = await Promise.all([
    prisma.stitch.count(),
    prisma.damageType.count(),
    prisma.material.count(),
    prisma.part.count(),
  ]);
  console.log(
    `[seed] 完成：针法 ${stitchCount} / 破损类型 ${damageTypeCount} / 材质 ${materialCount} / 部位 ${partCount}`,
  );
  console.log('[seed] 注意：本脚本不写入任何衣物、破损、修补示例数据。');
}

main()
  .catch((error) => {
    console.error('[seed] 失败', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
