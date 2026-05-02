import { useParams } from 'react-router';
import { useGetAgentQuery } from '../../entities/agent';
import { AgentSubagents } from '../../features/agent/subagents';

export default function AgentSubagentsPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const { data: agent } = useGetAgentQuery(agentId ?? '', { skip: !agentId });
  if (!agent?._id) return null;
  return <AgentSubagents agentId={String(agent._id)} />;
}
