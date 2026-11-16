import { AgentsDashboard } from "@/components/AgentsDashboard";

export const metadata = {
  title: "Coding Agents | Usage Monitor",
  description: "Live status, token counts, quota use, and list-price savings for coding tools.",
};

export default function AgentsPage() {
  return (
    <main className="container mx-auto px-4 py-8 max-w-7xl">
      <AgentsDashboard />
    </main>
  );
}
