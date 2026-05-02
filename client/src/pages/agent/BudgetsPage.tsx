import { useParams } from 'react-router';
import { useGetAgentQuery } from '../../entities/agent';
import { AgentBudgets } from '../../features/agent/budgets';

export default function AgentBudgetsPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const { data: agent } = useGetAgentQuery(agentId ?? '', { skip: !agentId });
  if (!agent?._id) return null;
  return <AgentBudgets agentId={String(agent._id)} />;
}
