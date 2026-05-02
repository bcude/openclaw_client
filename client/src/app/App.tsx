import { Suspense, lazy } from 'react';
import { Routes, Route, Navigate } from 'react-router';
import { CircularProgress, Box } from '@mui/material';

const Login = lazy(() => import('../pages/login'));
const PrivateRoute = lazy(() => import('../features/auth/PrivateRoute'));
const Users = lazy(() => import('../pages/user'));
const AgentChat = lazy(() => import('../pages/agent'));
const AgentSettingsLayout = lazy(() => import('../pages/agent/SettingsLayoutPage'));
const AgentWorkspaceFiles = lazy(() => import('../pages/agent/WorkspaceFilesPage'));
const AgentUsage = lazy(() => import('../pages/agent/UsagePage'));
const AgentBudgets = lazy(() => import('../pages/agent/BudgetsPage'));
const AgentSkills = lazy(() => import('../pages/agent/SkillsPage'));
const AgentSubagents = lazy(() => import('../pages/agent/SubagentsPage'));
const Plugins = lazy(() => import('../pages/plugins'));
const Skills = lazy(() => import('../pages/skills'));
const Channels = lazy(() => import('../pages/channels'));
const Cron = lazy(() => import('../pages/cron'));

function Loading() {
  return (
    <Box display="flex" justifyContent="center" alignItems="center" minHeight="100vh">
      <CircularProgress />
    </Box>
  );
}

function App() {
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <Suspense fallback={<Loading />}>
            <Login />
          </Suspense>
        }
      />
      <Route
        path="/"
        element={
          <Suspense fallback={<Loading />}>
            <PrivateRoute />
          </Suspense>
        }
      >
        <Route
          path="users"
          element={
            <Suspense fallback={<Loading />}>
              <Users />
            </Suspense>
          }
        />
        <Route
          path="plugins"
          element={
            <Suspense fallback={<Loading />}>
              <Plugins />
            </Suspense>
          }
        />
        <Route
          path="skills"
          element={
            <Suspense fallback={<Loading />}>
              <Skills />
            </Suspense>
          }
        />
        <Route
          path="channels"
          element={
            <Suspense fallback={<Loading />}>
              <Channels />
            </Suspense>
          }
        />
        <Route
          path="cron"
          element={
            <Suspense fallback={<Loading />}>
              <Cron />
            </Suspense>
          }
        />
        <Route
          path="agent/:agentId/chat/:conversationId"
          element={
            <Suspense fallback={<Loading />}>
              <AgentChat />
            </Suspense>
          }
        />
        <Route
          path="agent/:agentId"
          element={
            <Suspense fallback={<Loading />}>
              <AgentSettingsLayout />
            </Suspense>
          }
        >
          <Route index element={<Navigate to="workspace" replace />} />
          <Route
            path="workspace"
            element={
              <Suspense fallback={<Loading />}>
                <AgentWorkspaceFiles />
              </Suspense>
            }
          />
          <Route
            path="usage"
            element={
              <Suspense fallback={<Loading />}>
                <AgentUsage />
              </Suspense>
            }
          />
          <Route
            path="budgets"
            element={
              <Suspense fallback={<Loading />}>
                <AgentBudgets />
              </Suspense>
            }
          />
          <Route
            path="skills"
            element={
              <Suspense fallback={<Loading />}>
                <AgentSkills />
              </Suspense>
            }
          />
          <Route
            path="subagents"
            element={
              <Suspense fallback={<Loading />}>
                <AgentSubagents />
              </Suspense>
            }
          />
        </Route>
        <Route path="*" element="404" />
      </Route>
    </Routes>
  );
}

export default App;
