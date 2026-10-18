import { useEffect, useState } from "preact/hooks";
import { getToast, onToast, showToast } from "./lib/notify";

export function ToastHost() {
  const [toast, setToast] = useState(getToast());
  useEffect(() => onToast(() => setToast(getToast())), []);
  if (!toast) return null;
  return (
    <div class="toast" role="status">
      <span>{toast.text}</span>
      {toast.action && (
        <button
          class="link"
          onClick={() => {
            showToast(null);
            toast.action!.run();
          }}
        >
          {toast.action.label}
        </button>
      )}
    </div>
  );
}
