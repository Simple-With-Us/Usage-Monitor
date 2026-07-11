/* eslint-disable react-hooks/set-state-in-effect */
"use client";

import { useEffect, useState } from "react";
import ModalDialog from "@/components/ModalDialog";

export interface Project {
  id?: string;
  name: string;
  description?: string | null;
  monthlyBudgetUsd?: number | null;
}

interface AddProjectModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (project: Project) => Promise<void>;
  editProject?: Project | null;
}

function parseNumberField(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("Must be a non-negative number");
  }
  return parsed;
}

export default function AddProjectModal({
  open,
  onClose,
  onSave,
  editProject,
}: AddProjectModalProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [monthlyBudgetUsd, setMonthlyBudgetUsd] = useState("");

  useEffect(() => {
    if (!open) return;
    setError("");
    setName(editProject?.name || "");
    setDescription(editProject?.description || "");
    setMonthlyBudgetUsd(
      editProject?.monthlyBudgetUsd != null
        ? String(editProject.monthlyBudgetUsd)
        : ""
    );
  }, [editProject, open]);

  if (!open) return null;

  const handleSave = async () => {
    setError("");
    setSaving(true);
    try {
      if (!name.trim()) {
        throw new Error("Project name is required");
      }

      await onSave({
        id: editProject?.id,
        name: name.trim(),
        description: description.trim() || null,
        monthlyBudgetUsd: monthlyBudgetUsd ? parseNumberField(monthlyBudgetUsd) : null,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalDialog
      title={editProject ? "Edit Project" : "Add Project"}
      onClose={onClose}
      closeDisabled={saving}
      maxWidthClass="max-w-md"
    >
          {error && (
            <div role="alert" className="mb-4 p-3 bg-red-50 text-red-700 text-sm rounded-lg">
              {error}
            </div>
          )}

          <div className="space-y-4">
            <div>
              <label htmlFor="project-name" className="block text-sm font-medium text-gray-700 mb-1">
                Name
              </label>
              <input
                id="project-name"
                data-dialog-initial-focus
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., Data Platform"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label htmlFor="project-description" className="block text-sm font-medium text-gray-700 mb-1">
                Description (optional)
              </label>
              <input
                id="project-description"
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="e.g., Core data engineering team tools"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label htmlFor="project-budget" className="block text-sm font-medium text-gray-700 mb-1">
                Monthly Budget (USD)
              </label>
              <input
                id="project-budget"
                type="number"
                min="0"
                step="0.01"
                value={monthlyBudgetUsd}
                onChange={(e) => setMonthlyBudgetUsd(e.target.value)}
                placeholder="e.g., 500"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          <div className="mt-6 flex flex-wrap items-center justify-end gap-3 pt-6 border-t border-gray-100">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save Project"}
            </button>
          </div>
    </ModalDialog>
  );
}
