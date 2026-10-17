declare const __APP_VERSION__: string;

// public/js/pwa-install.js (copied from the pwa-cloudflare skill)
declare const PWAInstall: {
  init(opts: { appName?: string; autoShow?: boolean; remember?: "session" | number }): void;
  show(force?: boolean): boolean;
  isInstalled(): boolean;
};

// Google Identity Services, loaded from accounts.google.com in index.html
declare namespace google.accounts.id {
  function initialize(opts: {
    client_id: string;
    callback: (res: { credential: string }) => void;
    auto_select?: boolean;
    use_fedcm_for_prompt?: boolean;
  }): void;
  function renderButton(el: HTMLElement, opts: Record<string, unknown>): void;
  function disableAutoSelect(): void;
}
