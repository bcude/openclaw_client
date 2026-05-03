import { In, IsNull, Not } from 'typeorm';
import { RequestHandler } from 'express';
import AppDataSource from '../../data-source';
import { Agent, Conversation, Message } from '../../entities';
import { MessageRole } from '../../@types/message';
import { List, Get, Create, Update, Destroy, AgentJson } from '../../@types/agent';
import * as ocService from '../../services/openclaw';

function toSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'agent'
  );
}

const list: List = async (req, res, next) => {
  try {
    const { page = 0, limit = 40, sortField = 'createdAt', sortType = 'desc' } = req.query;
    const agentRepo = AppDataSource.getRepository(Agent);

    const qb = agentRepo.createQueryBuilder('agent');

    if (req.query.search) {
      const search = req.query.search as string;
      if (!Number.isNaN(Number(search))) {
        qb.andWhere('agent._id = :id', { id: Number(search) });
      } else {
        qb.andWhere('agent.name LIKE :s', { s: `%${search}%` });
      }
    }

    const total = await qb.getCount();
    const items = await qb
      .skip(Number(page) * Number(limit))
      .take(Number(limit))
      .orderBy(
        `agent.${sortField as string}`,
        (sortType as string).toUpperCase() === 'ASC' ? 'ASC' : 'DESC'
      )
      .getMany();

    const ocIds = items.map((a) => a.openclawAgentId);
    const models = ocService.getAgentModelsForOpenclawIds(ocIds);
    const itemsWithModel: AgentJson[] = items.map((a) => ({
      _id: a._id,
      name: a.name,
      openclawAgentId: a.openclawAgentId,
      createdBy: a.createdBy,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
      model: models[a.openclawAgentId] ?? null,
    }));

    return res.json({ total, items: itemsWithModel });
  } catch (error) {
    return next(error);
  }
};

const get: Get = async (req, res, next) => {
  try {
    const agentRepo = AppDataSource.getRepository(Agent);
    const agent = await agentRepo.findOneBy({ _id: Number(req.params.id) });
    if (!agent) return res.json(null);
    const model = ocService.getAgentModel(agent.openclawAgentId);
    const body: AgentJson = {
      _id: agent._id,
      name: agent.name,
      openclawAgentId: agent.openclawAgentId,
      createdBy: agent.createdBy,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
      model,
    };
    return res.json(body);
  } catch (error) {
    return next(error);
  }
};

const create: Create = async (req, res, next) => {
  try {
    const agentRepo = AppDataSource.getRepository(Agent);
    const { interactive, ...body } = req.body;
    const openclawAgentId = body.openclawAgentId?.trim() || toSlug(body.name || '');
    const agent = agentRepo.create({
      ...body,
      openclawAgentId,
      createdBy: req.user!._id,
      createdAt: new Date(),
    });
    const saved = await agentRepo.save(agent);

    if (!interactive) {
      ocService.registerAgent(openclawAgentId);
    }

    return res.json(saved);
  } catch (error) {
    return next(error);
  }
};

const update: Update = async (req, res, next) => {
  try {
    const agentRepo = AppDataSource.getRepository(Agent);
    const id = Number(req.params.id);

    await agentRepo.update(id, { name: req.body.name, updatedAt: new Date() });
    const agent = await agentRepo.findOneBy({ _id: id });
    if (!agent) return res.status(404).json(null);

    if (agent.openclawAgentId) {
      ocService.setAgentIdentity(agent.openclawAgentId, req.body.name || '');
    }

    return res.json(agent);
  } catch (error) {
    return next(error);
  }
};

const destroy: Destroy = async (req, res, next) => {
  try {
    const agentRepo = AppDataSource.getRepository(Agent);
    const convRepo = AppDataSource.getRepository(Conversation);
    const id = Number(req.params.id);

    const agent = await agentRepo.findOneBy({ _id: id });
    await agentRepo.softDelete(id);
    await convRepo
      .createQueryBuilder()
      .update(Conversation)
      .set({ deletedAt: new Date() })
      .where('agentId = :id', { id })
      .execute();

    if (agent?.openclawAgentId) {
      ocService.removeAgent(agent.openclawAgentId);
    }

    return res.json(null);
  } catch (error) {
    return next(error);
  }
};

const sync: RequestHandler = async (req, res, next) => {
  try {
    const agentRepo = AppDataSource.getRepository(Agent);
    const convRepo = AppDataSource.getRepository(Conversation);
    const msgRepo = AppDataSource.getRepository(Message);

    // Phase 1: Sync agents (filesystem scan, no CLI)
    const openclawAgents = ocService.listAgents();
    let syncedAgents = 0;

    if (openclawAgents.length) {
      const existingAgents = await agentRepo.find({
        where: { openclawAgentId: In(openclawAgents.map((a) => a.agentId)) },
      });
      const existingAgentIds = new Set(existingAgents.map((a) => a.openclawAgentId));

      const newAgents = openclawAgents.filter((a) => !existingAgentIds.has(a.agentId));
      if (newAgents.length) {
        await agentRepo.save(
          newAgents.map((a) =>
            agentRepo.create({
              name: a.name,
              openclawAgentId: a.agentId,
              createdBy: req.user!._id,
              createdAt: a.createdAt,
            })
          )
        );
        syncedAgents = newAgents.length;
      }
    }

    // Phase 2: Sync conversations (skip JSONL parsing for first messages)
    const allAgents = await agentRepo.find();

    const convResults = await Promise.allSettled(
      allAgents.map(async (agent) => {
        const sessions = ocService.listSessions(agent.openclawAgentId, true);
        if (!sessions.length) return 0;

        const existingConvs = await convRepo.find({
          where: {
            agentId: agent._id,
            sessionKey: In(sessions.map((s) => s.sessionKey)),
          },
        });
        const existingByKey = new Map(existingConvs.map((c) => [c.sessionKey, c]));

        const newSessions = sessions.filter((s) => !existingByKey.get(s.sessionKey));
        if (newSessions.length) {
          await convRepo.save(
            newSessions.map((s) =>
              convRepo.create({
                agentId: agent._id,
                sessionKey: s.sessionKey,
                title: s.label || null,
                createdBy: req.user!._id,
                createdAt: s.updatedAt ? new Date(s.updatedAt) : new Date(),
              })
            )
          );
        }

        const titleUpdates = sessions
          .map((s) => ({ session: s, existing: existingByKey.get(s.sessionKey) }))
          .filter(({ session, existing }) => existing && !existing.title && session.label);
        await Promise.all(
          titleUpdates.map(({ session, existing }) =>
            convRepo.update(existing!._id, { title: session.label })
          )
        );

        return newSessions.length;
      })
    );
    const syncedConversations = convResults.reduce(
      (sum, r) => sum + (r.status === 'fulfilled' ? r.value : 0),
      0
    );

    // Phase 3: Sync messages (only for conversations missing messages)
    const allConversations = await convRepo.find({
      where: { sessionKey: Not(IsNull()) },
    });

    const agentMap = new Map(allAgents.map((a) => [a._id, a]));

    const msgResults = await Promise.allSettled(
      allConversations.map(async (conv) => {
        const agent = agentMap.get(conv.agentId);
        if (!agent) return 0;

        const openclawMessages = ocService.getSessionMessages(
          agent.openclawAgentId,
          conv.sessionKey!
        );
        const validMessages = openclawMessages.filter((m) => m.externalId);
        if (!validMessages.length) return 0;

        const existingIds = new Set(
          (
            await msgRepo.find({
              where: { conversationId: conv._id },
              select: ['externalId'],
            })
          )
            .map((m) => m.externalId)
            .filter(Boolean)
        );

        const toInsert = validMessages.filter((m) => !existingIds.has(m.externalId));
        if (!toInsert.length) return 0;

        await msgRepo.save(
          toInsert.map((m) =>
            msgRepo.create({
              conversationId: conv._id,
              externalId: m.externalId,
              text: m.text,
              thinking: m.thinking || null,
              toolSteps: m.toolSteps && m.toolSteps.length > 0 ? m.toolSteps : null,
              files: [],
              role: m.role as MessageRole,
              createdBy: req.user!._id,
              createdAt: m.timestamp ? new Date(m.timestamp) : new Date(),
            })
          )
        );
        return toInsert.length;
      })
    );
    const syncedMessages = msgResults.reduce(
      (sum, r) => sum + (r.status === 'fulfilled' ? r.value : 0),
      0
    );

    return res.json({ syncedAgents, syncedConversations, syncedMessages });
  } catch (error) {
    return next(error);
  }
};

const workspaceMeta: RequestHandler = async (req, res, next) => {
  try {
    const agentRepo = AppDataSource.getRepository(Agent);
    const agent = await agentRepo.findOneBy({ _id: Number(req.params.id) });
    if (!agent?.openclawAgentId) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    return res.json(ocService.getWorkspaceMeta(agent.openclawAgentId));
  } catch (error) {
    return next(error);
  }
};

const getWorkspaceFile: RequestHandler = async (req, res, next) => {
  try {
    const agentRepo = AppDataSource.getRepository(Agent);
    const agent = await agentRepo.findOneBy({ _id: Number(req.params.id) });
    if (!agent?.openclawAgentId) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    return res.json(ocService.getWorkspaceFile(agent.openclawAgentId, req.params.filename));
  } catch (error) {
    return next(error);
  }
};

const getSessionSettings: RequestHandler = async (req, res, next) => {
  try {
    const agentRepo = AppDataSource.getRepository(Agent);
    const convRepo = AppDataSource.getRepository(Conversation);

    const agent = await agentRepo.findOneBy({ _id: Number(req.params.id) });
    if (!agent?.openclawAgentId) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    const conv = await convRepo.findOneBy({ _id: Number(req.params.conversationId) });
    if (!conv?.sessionKey) {
      return res.json({ ok: true, settings: {} });
    }
    const settings = ocService.getSessionSettings(agent.openclawAgentId, conv.sessionKey);
    return res.json({ ok: true, settings });
  } catch (error) {
    return next(error);
  }
};

const patchSessionSettings: RequestHandler = async (req, res, next) => {
  try {
    const agentRepo = AppDataSource.getRepository(Agent);
    const convRepo = AppDataSource.getRepository(Conversation);

    const agent = await agentRepo.findOneBy({ _id: Number(req.params.id) });
    if (!agent?.openclawAgentId) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    const conv = await convRepo.findOneBy({ _id: Number(req.params.conversationId) });
    const sessionKey = conv?.sessionKey || String(conv?._id);
    const result = await ocService.patchSessionSettings(
      agent.openclawAgentId,
      sessionKey,
      req.body
    );
    if (!result.ok) {
      return res.status(500).json(result);
    }
    return res.json(result);
  } catch (error) {
    return next(error);
  }
};

const putWorkspaceFile: RequestHandler = async (req, res, next) => {
  try {
    const agentRepo = AppDataSource.getRepository(Agent);
    const agent = await agentRepo.findOneBy({ _id: Number(req.params.id) });
    if (!agent?.openclawAgentId) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    const { content } = req.body as { content: string };
    const result = ocService.putWorkspaceFile(agent.openclawAgentId, req.params.filename, content);
    return res.json(result);
  } catch (error) {
    return next(error);
  }
};

const getBudget: RequestHandler = async (req, res, next) => {
  try {
    const agentRepo = AppDataSource.getRepository(Agent);
    const agent = await agentRepo.findOneBy({ _id: Number(req.params.id) });
    if (!agent?.openclawAgentId) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    return res.json(ocService.getAgentBudget(agent.openclawAgentId));
  } catch (error) {
    return next(error);
  }
};

const updateBudget: RequestHandler = async (req, res, next) => {
  try {
    const agentRepo = AppDataSource.getRepository(Agent);
    const agent = await agentRepo.findOneBy({ _id: Number(req.params.id) });
    if (!agent?.openclawAgentId) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    const result = ocService.setAgentBudget(agent.openclawAgentId, req.body || {});
    if (!result.ok) {
      return res.status(400).json(result);
    }
    return res.json(result);
  } catch (error) {
    return next(error);
  }
};

const getSkillsConfig: RequestHandler = async (req, res, next) => {
  try {
    const agentRepo = AppDataSource.getRepository(Agent);
    const agent = await agentRepo.findOneBy({ _id: Number(req.params.id) });
    if (!agent?.openclawAgentId) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    return res.json(ocService.getAgentSkillsConfig(agent.openclawAgentId));
  } catch (error) {
    return next(error);
  }
};

const updateSkillsConfig: RequestHandler = async (req, res, next) => {
  try {
    const agentRepo = AppDataSource.getRepository(Agent);
    const agent = await agentRepo.findOneBy({ _id: Number(req.params.id) });
    if (!agent?.openclawAgentId) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    const body = (req.body ?? {}) as { skills?: string[] | null };
    const skills = body.skills === undefined ? null : body.skills;
    const result = ocService.setAgentSkills(agent.openclawAgentId, skills);
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  } catch (error) {
    return next(error);
  }
};

const getSubagentsConfig: RequestHandler = async (req, res, next) => {
  try {
    const agentRepo = AppDataSource.getRepository(Agent);
    const agent = await agentRepo.findOneBy({ _id: Number(req.params.id) });
    if (!agent?.openclawAgentId) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    return res.json(ocService.getAgentSubagentsConfig(agent.openclawAgentId));
  } catch (error) {
    return next(error);
  }
};

const updateSubagentsConfig: RequestHandler = async (req, res, next) => {
  try {
    const agentRepo = AppDataSource.getRepository(Agent);
    const agent = await agentRepo.findOneBy({ _id: Number(req.params.id) });
    if (!agent?.openclawAgentId) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    const result = ocService.setAgentSubagents(agent.openclawAgentId, req.body ?? {});
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  } catch (error) {
    return next(error);
  }
};

const getUsage: RequestHandler = async (req, res, next) => {
  try {
    const agentRepo = AppDataSource.getRepository(Agent);
    const agent = await agentRepo.findOneBy({ _id: Number(req.params.id) });
    if (!agent?.openclawAgentId) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    const usage = await ocService.getAgentUsage(agent.openclawAgentId);
    return res.json(usage);
  } catch (error) {
    return next(error);
  }
};

const getProviderModels: RequestHandler = async (req, res, next) => {
  try {
    const agentRepo = AppDataSource.getRepository(Agent);
    const agent = await agentRepo.findOneBy({ _id: Number(req.params.id) });
    if (!agent?.openclawAgentId) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    return res.json(ocService.getAgentProviderModels(agent.openclawAgentId));
  } catch (error) {
    return next(error);
  }
};

const updateProviderModel: RequestHandler = async (req, res, next) => {
  try {
    const agentRepo = AppDataSource.getRepository(Agent);
    const convRepo = AppDataSource.getRepository(Conversation);

    const agent = await agentRepo.findOneBy({ _id: Number(req.params.id) });
    if (!agent?.openclawAgentId) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const body = (req.body ?? {}) as { model?: string; conversationId?: number | string };
    const modelKey = typeof body.model === 'string' ? body.model : '';

    let sessionKey: string | null = null;
    if (body.conversationId !== undefined && body.conversationId !== null) {
      const conv = await convRepo.findOneBy({ _id: Number(body.conversationId) });
      sessionKey = conv?.sessionKey || (conv ? String(conv._id) : null);
    }

    const result = await ocService.setAgentProviderModel(
      agent.openclawAgentId,
      modelKey,
      sessionKey
    );
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  } catch (error) {
    return next(error);
  }
};

const getLimits: RequestHandler = async (req, res, next) => {
  try {
    const agentRepo = AppDataSource.getRepository(Agent);
    const agent = await agentRepo.findOneBy({ _id: Number(req.params.id) });
    if (!agent?.openclawAgentId) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    const limits = await ocService.getAgentLimits(agent);
    return res.json({
      ...limits,
      stored: {
        costLimitDaily: agent.costLimitDaily,
        costLimitMonthly: agent.costLimitMonthly,
        costLimitTotal: agent.costLimitTotal,
      },
    });
  } catch (error) {
    return next(error);
  }
};

const updateLimits: RequestHandler = async (req, res, next) => {
  try {
    const agentRepo = AppDataSource.getRepository(Agent);
    const agent = await agentRepo.findOneBy({ _id: Number(req.params.id) });
    if (!agent?.openclawAgentId) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    const result = await ocService.setAgentLimits(agent, req.body ?? {});
    if (!result.ok) return res.status(400).json(result);
    const fresh = await agentRepo.findOneByOrFail({ _id: agent._id });
    return res.json({
      ...result.config,
      stored: {
        costLimitDaily: fresh.costLimitDaily,
        costLimitMonthly: fresh.costLimitMonthly,
        costLimitTotal: fresh.costLimitTotal,
      },
    });
  } catch (error) {
    return next(error);
  }
};

const serveWorkspaceUpload: RequestHandler = async (req, res, next) => {
  try {
    const agentRepo = AppDataSource.getRepository(Agent);
    const agent = await agentRepo.findOneBy({ _id: Number(req.params.id) });
    if (!agent?.openclawAgentId) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    const fp = ocService.getWorkspaceUploadPath(agent.openclawAgentId, req.params.filename);
    if (!fp) return res.status(404).json({ error: 'File not found' });
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    return res.sendFile(fp);
  } catch (error) {
    return next(error);
  }
};

export {
  list,
  get,
  create,
  update,
  destroy,
  sync,
  workspaceMeta,
  getWorkspaceFile,
  putWorkspaceFile,
  getSessionSettings,
  patchSessionSettings,
  serveWorkspaceUpload,
  getBudget,
  updateBudget,
  getSkillsConfig,
  updateSkillsConfig,
  getSubagentsConfig,
  updateSubagentsConfig,
  getProviderModels,
  updateProviderModel,
  getUsage,
  getLimits,
  updateLimits,
};
