/* eslint-disable no-console */
import {
  AgentLimitWindow,
  AgentLimitWindowState,
  AgentLimitsResponse,
  AgentLimitsPatch,
} from '../../@types/openclaw';
import AppDataSource from '../../data-source';
import { Agent } from '../../entities';
import { type RawSessionUsage } from './agentUsage';
import { getAgentRawUsageFromDisk, invalidateLocalUsageCache } from './localUsage';

const RESPONSE_TTL_MS = 3000;
const responseCache = new Map<string, { at: number; data: AgentLimitsResponse }>();

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isoMonth(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

interface PerWindowSpend {
  daily: number;
  monthly: number;
  total: number;
  today: string;
  thisMonth: string;
}

function spendForAgent(usages: RawSessionUsage[]): PerWindowSpend {
  const now = new Date();
  const today = isoDate(now);
  const thisMonth = isoMonth(now);

  return usages.reduce<PerWindowSpend>(
    (acc, u) => {
      const breakdown = u?.dailyBreakdown ?? [];
      breakdown.forEach((row) => {
        if (!row?.date) return;
        const cost = num(row.cost);
        if (row.date === today) acc.daily += cost;
        if (row.date.startsWith(thisMonth)) acc.monthly += cost;
      });
      acc.total += num(u?.totalCost);
      return acc;
    },
    { daily: 0, monthly: 0, total: 0, today, thisMonth }
  );
}

function buildWindow(limit: number | null, spent: number): AgentLimitWindowState {
  if (limit == null) {
    return { limit: null, spent, ratio: null, exceeded: false, nearLimit: false };
  }
  const ratio = limit > 0 ? spent / limit : 0;
  return {
    limit,
    spent,
    ratio,
    exceeded: spent >= limit,
    nearLimit: ratio >= 0.8 && spent < limit,
  };
}

export async function getAgentLimits(agent: Agent): Promise<AgentLimitsResponse> {
  const cacheKey = `${agent._id}|${agent.costLimitDaily ?? 'x'}|${agent.costLimitMonthly ?? 'x'}|${
    agent.costLimitTotal ?? 'x'
  }`;
  const cached = responseCache.get(cacheKey);
  if (cached && Date.now() - cached.at < RESPONSE_TTL_MS) {
    return cached.data;
  }

  const payload = await getAgentRawUsageFromDisk(agent.openclawAgentId);
  const sessions = (payload?.sessions ?? []).filter((s) => s?.agentId === agent.openclawAgentId);
  const usages = sessions
    .map((s) => s.usage)
    .filter((u): u is RawSessionUsage => !!u && typeof u === 'object');

  const spend = spendForAgent(usages);

  const response: AgentLimitsResponse = {
    agentId: agent.openclawAgentId,
    today: spend.today,
    thisMonth: spend.thisMonth,
    windows: {
      daily: buildWindow(agent.costLimitDaily, spend.daily),
      monthly: buildWindow(agent.costLimitMonthly, spend.monthly),
      total: buildWindow(agent.costLimitTotal, spend.total),
    },
  };
  responseCache.set(cacheKey, { at: Date.now(), data: response });
  return response;
}

const COLUMN_BY_WINDOW: Record<
  AgentLimitWindow,
  keyof Pick<Agent, 'costLimitDaily' | 'costLimitMonthly' | 'costLimitTotal'>
> = {
  daily: 'costLimitDaily',
  monthly: 'costLimitMonthly',
  total: 'costLimitTotal',
};

const ALLOWED_KEYS = new Set<string>(Object.values(COLUMN_BY_WINDOW));

export interface SetAgentLimitsResult {
  ok: boolean;
  error?: string;
  config?: AgentLimitsResponse;
}

export async function setAgentLimits(
  agent: Agent,
  patch: AgentLimitsPatch
): Promise<SetAgentLimitsResult> {
  const repo = AppDataSource.getRepository(Agent);
  const update: Partial<Agent> = {};

  const entries = Object.entries(patch ?? {}) as [string, number | null | undefined][];
  const validation = entries.reduce<{ ok: false; error: string } | null>((acc, [key, value]) => {
    if (acc) return acc;
    if (!ALLOWED_KEYS.has(key)) {
      return { ok: false, error: `Unknown limit field: ${key}` };
    }
    if (value === undefined) return null; // skipped — leave column unchanged
    if (value === null) {
      (update as Record<string, unknown>)[key] = null;
      return null;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return { ok: false, error: `"${key}" must be a non-negative number or null.` };
    }
    (update as Record<string, unknown>)[key] = value;
    return null;
  }, null);

  if (validation) return validation;

  if (Object.keys(update).length > 0) {
    await repo.update({ _id: agent._id }, { ...update, updatedAt: new Date() });
  }

  invalidateLocalUsageCache();
  responseCache.clear();
  const fresh = await repo.findOneByOrFail({ _id: agent._id });
  const config = await getAgentLimits(fresh);
  return { ok: true, config };
}
