import { type Project } from "@/components/AddProjectModal";
import ListLoadErrorPanel from "@/components/ListLoadErrorPanel";
import { formatCurrency } from "@/lib/format";

interface ProjectTableProps {
  projects: Project[];
  actionLoading: string | null;
  deleteProjectConfirm: string | null;
  onEdit: (project: Project) => void;
  onDeleteConfirmStart: (id: string) => void;
  onDeleteConfirmCancel: () => void;
  onDelete: (id: string) => void;
  onAddProject: () => void;
  /** Message from a failed project load; suppresses the empty-state CTA. */
  loadError?: string | null;
  onRetryLoad?: () => void;
}

export default function ProjectTable({
  projects,
  actionLoading,
  deleteProjectConfirm,
  onEdit,
  onDeleteConfirmStart,
  onDeleteConfirmCancel,
  onDelete,
  onAddProject,
  loadError,
  onRetryLoad,
}: ProjectTableProps) {
  const formatUsd = (amount: number | null | undefined) => formatCurrency(amount);

  if (projects.length === 0) {
    if (loadError) {
      return (
        <ListLoadErrorPanel
          message="Projects couldn't be loaded."
          detail={loadError}
          onRetry={onRetryLoad}
        />
      );
    }
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-4 text-center bg-white rounded-xl border border-gray-200 dark:border-gray-700 dark:bg-gray-800">
        <p className="text-gray-500 dark:text-gray-400">No projects configured yet.</p>
        <button
          type="button"
          onClick={onAddProject}
          className="inline-flex min-h-11 items-center px-4 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700"
        >
          Add your first project
        </button>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 dark:border-gray-700 dark:bg-gray-800 overflow-x-clip">
      <table className="responsive-table w-full text-sm">
        <caption className="sr-only">Configured projects and budgets</caption>
        <thead>
          <tr className="border-b border-gray-100 bg-gray-50 dark:border-gray-700 dark:bg-gray-900/60 [&>th]:sticky [&>th]:top-28 [&>th]:z-20 [&>th]:bg-gray-50 dark:[&>th]:bg-gray-900">
            <th className="text-left px-6 py-3 font-medium text-gray-500 dark:text-gray-400">
              Name
            </th>
            <th className="text-left px-6 py-3 font-medium text-gray-500 dark:text-gray-400">
              Description
            </th>
            <th className="text-left px-6 py-3 font-medium text-gray-500 dark:text-gray-400">
              Monthly Budget
            </th>
            <th className="text-right px-6 py-3 font-medium text-gray-500 dark:text-gray-400">
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {projects.map((project) => (
            <tr
              key={project.id!}
              className="border-b border-gray-50 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700/40"
            >
              <td data-label="Name" className="px-6 py-4">
                <p className="font-medium text-gray-900 dark:text-gray-100">{project.name}</p>
              </td>
              <td data-label="Description" className="px-6 py-4">
                <p className="text-gray-500 dark:text-gray-400">{project.description || "--"}</p>
              </td>
              <td data-label="Monthly budget" className="px-6 py-4 text-gray-500 dark:text-gray-400">
                {formatUsd(project.monthlyBudgetUsd)}
              </td>
              <td data-label="Actions" className="px-6 py-4">
                <div className="table-actions flex flex-wrap items-center justify-end gap-2">
                  <button
                    type="button"
                    aria-label={`Edit ${project.name}`}
                    onClick={() => onEdit(project)}
                    className="inline-flex min-h-11 items-center rounded-md bg-gray-50 px-3 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-100 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
                  >
                    Edit
                  </button>
                  {deleteProjectConfirm === project.id ? (
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        aria-label={`Confirm deletion of ${project.name}`}
                        onClick={() => onDelete(project.id!)}
                        disabled={actionLoading === project.id}
                        className="inline-flex min-h-11 items-center rounded-md bg-red-600 px-3 text-xs font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        aria-label={`Cancel deletion of ${project.name}`}
                        onClick={() => onDeleteConfirmCancel()}
                        className="inline-flex min-h-11 items-center px-2 text-xs text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Delete ${project.name}`}
                      onClick={() => onDeleteConfirmStart(project.id!)}
                      className="inline-flex min-h-11 items-center rounded-md bg-red-50 px-3 text-xs font-medium text-red-600 transition-colors hover:bg-red-100 dark:bg-red-950/60 dark:text-red-300 dark:hover:bg-red-900/60"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
