import { type Project } from "@/components/AddProjectModal";

interface ProjectTableProps {
  projects: Project[];
  actionLoading: string | null;
  deleteProjectConfirm: string | null;
  onEdit: (project: Project) => void;
  onDeleteConfirmStart: (id: string) => void;
  onDeleteConfirmCancel: () => void;
  onDelete: (id: string) => void;
  onAddProject: () => void;
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
}: ProjectTableProps) {
  const formatUsd = (amount: number | null | undefined) => {
    if (amount == null) return "--";
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    }).format(amount);
  };

  if (projects.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-4 text-center bg-white rounded-xl border border-gray-200">
        <p className="text-gray-500">No projects configured yet.</p>
        <button
          type="button"
          onClick={onAddProject}
          className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700"
        >
          Add your first project
        </button>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
      <table className="responsive-table w-full text-sm">
        <caption className="sr-only">Configured projects and budgets</caption>
        <thead>
          <tr className="border-b border-gray-100 bg-gray-50">
            <th className="text-left px-6 py-3 font-medium text-gray-500">
              Name
            </th>
            <th className="text-left px-6 py-3 font-medium text-gray-500">
              Description
            </th>
            <th className="text-left px-6 py-3 font-medium text-gray-500">
              Monthly Budget
            </th>
            <th className="text-right px-6 py-3 font-medium text-gray-500">
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {projects.map((project) => (
            <tr
              key={project.id!}
              className="border-b border-gray-50 hover:bg-gray-50"
            >
              <td data-label="Name" className="px-6 py-4">
                <p className="font-medium text-gray-900">{project.name}</p>
              </td>
              <td data-label="Description" className="px-6 py-4">
                <p className="text-gray-500">{project.description || "--"}</p>
              </td>
              <td data-label="Monthly budget" className="px-6 py-4 text-gray-500">
                {formatUsd(project.monthlyBudgetUsd)}
              </td>
              <td data-label="Actions" className="px-6 py-4">
                <div className="table-actions flex flex-wrap items-center justify-end gap-2">
                  <button
                    type="button"
                    aria-label={`Edit ${project.name}`}
                    onClick={() => onEdit(project)}
                    className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-50 hover:bg-gray-100 rounded-md transition-colors"
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
                        className="px-3 py-1.5 text-xs font-medium text-white bg-red-600 hover:bg-red-700 rounded-md transition-colors disabled:opacity-50"
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        aria-label={`Cancel deletion of ${project.name}`}
                        onClick={() => onDeleteConfirmCancel()}
                        className="px-2 py-1.5 text-xs text-gray-400 hover:text-gray-600"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Delete ${project.name}`}
                      onClick={() => onDeleteConfirmStart(project.id!)}
                      className="px-3 py-1.5 text-xs font-medium text-red-600 bg-red-50 hover:bg-red-100 rounded-md transition-colors"
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
