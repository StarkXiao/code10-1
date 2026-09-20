/**
 * 内置提醒规则（项目文档 12.2）。
 * 新衣橱创建时写入这些规则，用户可逐条关闭或改参数，但删不掉内置规则（只能停用）。
 */
import type { ReminderTriggerKind } from '@gml/shared';

export interface BuiltinRule {
  code: string;
  name: string;
  triggerKind: ReminderTriggerKind;
  params: Record<string, unknown>;
  scopeFilter: Record<string, unknown>;
  scheduleCron: string;
  channel: 'inapp' | 'inapp_email' | 'inapp_webhook';
  priority: 'low' | 'normal' | 'high';
  description: string;
}

export const BUILTIN_RULES: BuiltinRule[] = [
  {
    code: 'R1_repair_followup',
    name: '修补后复检',
    triggerKind: 'repair_followup',
    params: { observationDaysSelf: 14, observationDaysShop: 7, expireDays: 30 },
    scopeFilter: {},
    scheduleCron: '0 * * * *',
    channel: 'inapp',
    priority: 'high',
    description: '修补进入观察期后，到期提醒你做一次复检，并填写结论。',
  },
  {
    code: 'R2_observation_due',
    name: '观察期提前提醒',
    triggerKind: 'observation_due',
    params: { advanceNoticeDays: 2 },
    scopeFilter: {},
    scheduleCron: '0 * * * *',
    channel: 'inapp',
    priority: 'normal',
    description: '复检到期前 2 天把提醒推到待办列表，避免被忘掉。',
  },
  {
    code: 'R3_wear_threshold',
    name: '高频穿着加检',
    triggerKind: 'wear_threshold',
    params: { wearCount30Days: 8 },
    scopeFilter: {},
    scheduleCron: '0 * * * *',
    channel: 'inapp',
    priority: 'normal',
    description: '最近 30 天穿着 8 次以上、且还有未复检的修补时，提前提醒检查。',
  },
  {
    code: 'R4_wash_cycle',
    name: '洗护周期提醒',
    triggerKind: 'wash_cycle',
    params: {},
    scopeFilter: {},
    scheduleCron: '0 * * * *',
    channel: 'inapp',
    priority: 'low',
    description: '按材质的建议清洗周期（羊毛 3 次、棉 1 次、牛仔 5 次……）提醒清洗，并给出洗护注意。',
  },
  {
    code: 'R5_season_switch',
    name: '换季检查',
    triggerKind: 'season_switch',
    params: { months: [3, 11] },
    scopeFilter: {},
    scheduleCron: '0 * * * *',
    channel: 'inapp',
    priority: 'normal',
    description: '3 月与 11 月提醒做换季检查：清洁、检查破损、更新收纳位置。',
  },
  {
    code: 'R6_pending_damage',
    name: '长期未处理的破损',
    triggerKind: 'custom',
    params: { mode: 'long_pending', pendingDays: 30 },
    scopeFilter: {},
    scheduleCron: '0 * * * *',
    channel: 'inapp',
    priority: 'normal',
    description: '破损登记超过 30 天还没处理，问一句"还修吗"，可直接转退役。',
  },
  {
    code: 'R7_inventory_low',
    name: '耗材低库存',
    triggerKind: 'inventory_low',
    params: {},
    scopeFilter: {},
    scheduleCron: '0 * * * *',
    channel: 'inapp',
    priority: 'low',
    description: '补丁布余量低于阈值时提醒补货，避免临到要用才发现没了。',
  },
  {
    code: 'R8_lifecycle_review',
    name: '服役评估',
    triggerKind: 'lifecycle_review',
    params: { serviceDays: 1095, repairCount: 3 },
    scopeFilter: {},
    scheduleCron: '0 * * * *',
    channel: 'inapp',
    priority: 'low',
    description: '服役满 3 年或累计修补 3 次，提醒评估"继续穿还是处置"。',
  },
  {
    code: 'R9_recurrence_warning',
    name: '复发预警',
    triggerKind: 'custom',
    params: { mode: 'recurrence' },
    scopeFilter: {},
    scheduleCron: '0 * * * *',
    channel: 'inapp',
    priority: 'normal',
    description: '同部位同类型再次破损时提示更换针法或加预防性加固。',
  },
];

export const BUILTIN_RULE_CODES = BUILTIN_RULES.map((r) => r.code);
