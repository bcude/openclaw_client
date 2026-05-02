import { useParams } from 'react-router';
import { WorkspaceFileTabs } from '../../widgets/workspace';

export default function AgentWorkspaceFilesPage() {
  const { agentId } = useParams<{ agentId: string }>();
  if (!agentId) return null;
  return <WorkspaceFileTabs agentId={agentId} />;
}
