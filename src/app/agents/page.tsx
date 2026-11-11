import { AgentsDashboard } from "@/components/AgentsDashboard";

export const metadata = {
  title: "Coding Agents | Usage Monitor",
  description: "Live process status, token telemetry, quota burn, and PAYG API-equivalent cost savings for AI coding agents.",
};

export default function AgentsPage() {
  return (
    <main className="container mx-auto px-4 py-8 max-w-7xl">
      <AgentsDashboard />
    </main>
  );
}
