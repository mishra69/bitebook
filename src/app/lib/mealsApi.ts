import { mealsChanged, showToast } from "./notify";

// Deleting a saved meal hides it at once; it stays restorable for 30 days (D12).
export async function deleteSavedMeal(id: string, label: string): Promise<boolean> {
  const res = await fetch(`/api/meals/${id}`, { method: "DELETE" }).catch(() => null);
  if (!res?.ok) {
    showToast({ text: "Couldn't delete the meal. Are you online?" });
    return false;
  }
  mealsChanged();
  showToast({ text: `Deleted ${label}.`, action: { label: "Undo", run: () => restoreSavedMeal(id) } });
  return true;
}

export async function restoreSavedMeal(id: string): Promise<boolean> {
  const res = await fetch(`/api/meals/${id}/restore`, { method: "POST" }).catch(() => null);
  if (!res?.ok) {
    showToast({ text: "Couldn't restore the meal. Are you online?" });
    return false;
  }
  mealsChanged();
  showToast({ text: "Meal restored." }, 3000);
  return true;
}
