import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { Layout } from "@/components/layout/Layout";
import { CommandPalette } from "@/components/ui/CommandPalette";
import { useWebSocket } from "@/hooks/use-websocket";
import { useAuthStore } from "@/stores/auth";

const OverviewPage = lazy(() =>
  import("@/pages/Overview").then((m) => ({ default: m.OverviewPage })),
);
const ChatPage = lazy(() =>
  import("@/pages/Chat").then((m) => ({ default: m.ChatPage })),
);
const AgentsPage = lazy(() =>
  import("@/pages/Agents").then((m) => ({ default: m.AgentsPage })),
);
const SessionsPage = lazy(() =>
  import("@/pages/Sessions").then((m) => ({ default: m.SessionsPage })),
);
const MemoryPage = lazy(() =>
  import("@/pages/Memory").then((m) => ({ default: m.MemoryPage })),
);
const SystemPage = lazy(() =>
  import("@/pages/System").then((m) => ({ default: m.SystemPage })),
);
const SchedulesPage = lazy(() =>
  import("@/pages/Schedules").then((m) => ({ default: m.SchedulesPage })),
);
const SettingsPage = lazy(() =>
  import("@/pages/Settings").then((m) => ({ default: m.SettingsPage })),
);
const SkillsPage = lazy(() =>
  import("@/pages/Skills").then((m) => ({ default: m.SkillsPage })),
);
const ApprovalsPage = lazy(() =>
  import("@/pages/Approvals").then((m) => ({ default: m.ApprovalsPage })),
);
const PipelinesPage = lazy(() =>
  import("@/pages/Pipelines").then((m) => ({ default: m.PipelinesPage })),
);
const PromptVersionsPage = lazy(() =>
  import("@/pages/PromptVersions").then((m) => ({ default: m.PromptVersionsPage })),
);
const AlertsPage = lazy(() =>
  import("@/pages/Alerts").then((m) => ({ default: m.AlertsPage })),
);
const CostsPage = lazy(() =>
  import("@/pages/Costs").then((m) => ({ default: m.CostsPage })),
);
const WebhooksPage = lazy(() =>
  import("@/pages/Webhooks").then((m) => ({ default: m.WebhooksPage })),
);
const AgentComparePage = lazy(() =>
  import("@/pages/AgentCompare").then((m) => ({ default: m.AgentComparePage })),
);
const ActivityTimelinePage = lazy(() =>
  import("@/pages/ActivityTimeline").then((m) => ({ default: m.ActivityTimelinePage })),
);
const SteeringPage = lazy(() =>
  import("@/pages/Steering").then((m) => ({ default: m.SteeringPage })),
);
const SpawnsPage = lazy(() =>
  import("@/pages/Spawns").then((m) => ({ default: m.SpawnsPage })),
);
const ModelRouterPage = lazy(() =>
  import("@/pages/ModelRouter").then((m) => ({ default: m.ModelRouterPage })),
);
const PlaygroundPage = lazy(() =>
  import("@/pages/Playground").then((m) => ({ default: m.PlaygroundPage })),
);
const MemoryGraphPage = lazy(() =>
  import("@/pages/MemoryGraph").then((m) => ({ default: m.MemoryGraphPage })),
);
const TokenHeatmapPage = lazy(() =>
  import("@/pages/TokenHeatmap").then((m) => ({ default: m.TokenHeatmapPage })),
);
const AuditLogPage = lazy(() =>
  import("@/pages/AuditLog").then((m) => ({ default: m.AuditLogPage })),
);
const LiveFeedPage = lazy(() =>
  import("@/pages/LiveFeed").then((m) => ({ default: m.LiveFeedPage })),
);
const GuardrailsPage = lazy(() =>
  import("@/pages/Guardrails").then((m) => ({ default: m.GuardrailsPage })),
);
const UserProfilePage = lazy(() =>
  import("@/pages/UserProfile").then((m) => ({ default: m.UserProfilePage })),
);
const AgentWizardPage = lazy(() =>
  import("@/pages/AgentWizard").then((m) => ({ default: m.AgentWizardPage })),
);
const OpsConsolePage = lazy(() => import("@/pages/OpsConsole"));
const ApprovalQueuePage = lazy(() => import("@/pages/ApprovalQueue"));
const AuditViewerPage = lazy(() => import("@/pages/AuditViewer"));
const BillingDashboardPage = lazy(() => import("@/pages/BillingDashboard"));
const SkillMarketplacePage = lazy(() => import("@/pages/SkillMarketplace"));
const LoginPage = lazy(() =>
  import("@/pages/Login").then((m) => ({ default: m.LoginPage })),
);

function PageLoader() {
  return (
    <div className="flex h-64 items-center justify-center">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-700 border-t-sky-500" />
    </div>
  );
}

function FullPageLoader() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-sky-500" />
    </div>
  );
}

function ProtectedRoute({ children }: { children: ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isInitializing = useAuthStore((s) => s.isInitializing);
  const location = useLocation();

  if (isInitializing) return <FullPageLoader />;

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }

  return <>{children}</>;
}

export default function App() {
  const init = useAuthStore((s) => s.init);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  useEffect(() => {
    init();
  }, [init]);

  useWebSocket(isAuthenticated);

  return (
    <>
      <CommandPalette />
      <Routes>
        {/* Public route */}
        <Route
          path="/login"
          element={
            <Suspense fallback={<FullPageLoader />}>
              <LoginPage />
            </Suspense>
          }
        />

        {/* Protected routes */}
        <Route
          element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }
        >
          <Route path="/" element={<Suspense fallback={<PageLoader />}><OverviewPage /></Suspense>} />
          <Route path="/chat" element={<Suspense fallback={<PageLoader />}><ChatPage /></Suspense>} />
          <Route path="/agents" element={<Suspense fallback={<PageLoader />}><AgentsPage /></Suspense>} />
          <Route path="/agents/compare" element={<Suspense fallback={<PageLoader />}><AgentComparePage /></Suspense>} />
          <Route path="/sessions" element={<Suspense fallback={<PageLoader />}><SessionsPage /></Suspense>} />
          <Route path="/memory" element={<Suspense fallback={<PageLoader />}><MemoryPage /></Suspense>} />
          <Route path="/schedules" element={<Suspense fallback={<PageLoader />}><SchedulesPage /></Suspense>} />
          <Route path="/costs" element={<Suspense fallback={<PageLoader />}><CostsPage /></Suspense>} />
          <Route path="/webhooks" element={<Suspense fallback={<PageLoader />}><WebhooksPage /></Suspense>} />
          <Route path="/activity" element={<Suspense fallback={<PageLoader />}><ActivityTimelinePage /></Suspense>} />
          <Route path="/steering" element={<Suspense fallback={<PageLoader />}><SteeringPage /></Suspense>} />
          <Route path="/skills" element={<Suspense fallback={<PageLoader />}><SkillsPage /></Suspense>} />
          <Route path="/spawns" element={<Suspense fallback={<PageLoader />}><SpawnsPage /></Suspense>} />
          <Route path="/model-router" element={<Suspense fallback={<PageLoader />}><ModelRouterPage /></Suspense>} />
          <Route path="/playground" element={<Suspense fallback={<PageLoader />}><PlaygroundPage /></Suspense>} />
          <Route path="/memory-graph" element={<Suspense fallback={<PageLoader />}><MemoryGraphPage /></Suspense>} />
          <Route path="/token-heatmap" element={<Suspense fallback={<PageLoader />}><TokenHeatmapPage /></Suspense>} />
          <Route path="/audit-log" element={<Suspense fallback={<PageLoader />}><AuditLogPage /></Suspense>} />
          <Route path="/live-feed" element={<Suspense fallback={<PageLoader />}><LiveFeedPage /></Suspense>} />
          <Route path="/guardrails" element={<Suspense fallback={<PageLoader />}><GuardrailsPage /></Suspense>} />
          <Route path="/user-profile" element={<Suspense fallback={<PageLoader />}><UserProfilePage /></Suspense>} />
          <Route path="/agent-wizard" element={<Suspense fallback={<PageLoader />}><AgentWizardPage /></Suspense>} />
          <Route path="/ops-console" element={<Suspense fallback={<PageLoader />}><OpsConsolePage /></Suspense>} />
          <Route path="/approval-queue" element={<Suspense fallback={<PageLoader />}><ApprovalQueuePage /></Suspense>} />
          <Route path="/audit-viewer" element={<Suspense fallback={<PageLoader />}><AuditViewerPage /></Suspense>} />
          <Route path="/billing" element={<Suspense fallback={<PageLoader />}><BillingDashboardPage /></Suspense>} />
          <Route path="/skill-marketplace" element={<Suspense fallback={<PageLoader />}><SkillMarketplacePage /></Suspense>} />
          <Route path="/system" element={<Suspense fallback={<PageLoader />}><SystemPage /></Suspense>} />
          <Route path="/settings" element={<Suspense fallback={<PageLoader />}><SettingsPage /></Suspense>} />
          <Route path="/approvals" element={<Suspense fallback={<PageLoader />}><ApprovalsPage /></Suspense>} />
          <Route path="/pipelines" element={<Suspense fallback={<PageLoader />}><PipelinesPage /></Suspense>} />
          <Route path="/prompt-versions" element={<Suspense fallback={<PageLoader />}><PromptVersionsPage /></Suspense>} />
          <Route path="/alerts" element={<Suspense fallback={<PageLoader />}><AlertsPage /></Suspense>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </>
  );
}
