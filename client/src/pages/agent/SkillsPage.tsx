import { useParams } from 'react-router';
import { useGetAgentQuery } from '../../entities/agent';
import { AgentSkills } from '../../features/agent/skills';

export default function AgentSkillsPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const { data: agent } = useGetAgentQuery(agentId ?? '', { skip: !agentId });
  if (!agent?._id) return null;
  return <AgentSkills agentId={String(agent._id)} />;
}
