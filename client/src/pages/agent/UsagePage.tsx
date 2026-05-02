import { useParams } from 'react-router';
import { useGetAgentQuery } from '../../entities/agent';
import { AgentUsage } from '../../features/agent/usage';

export default function AgentUsagePage() {
  const { agentId } = useParams<{ agentId: string }>();
  const { data: agent } = useGetAgentQuery(agentId ?? '', { skip: !agentId });
  if (!agent?._id) return null;
  return <AgentUsage agentId={String(agent._id)} />;
}
