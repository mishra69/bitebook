// webpush-edge ships plain JS; just the parts Bitebook uses (D25).
declare module "webpush-edge" {
  type Subscription = { endpoint: string; keys: { p256dh: string; auth: string } };
  export function createPusher(config: {
    publicKey: string;
    privateJwk: string | object;
    contact: string;
    store: { get(userId: string): Promise<Subscription[]>; set(userId: string, subs: Subscription[]): Promise<void> };
  }): {
    send(
      userId: string,
      notification: { title: string; body?: string; navigate?: string; tag?: string },
      options?: { ttl?: number; urgency?: "very-low" | "low" | "normal" | "high"; topic?: string },
    ): Promise<{ sent: number; failed: number; pruned: number; results: { endpoint: string; status: number; ok: boolean }[] }>;
  };
}

declare module "webpush-edge/client" {
  export function pushSupport(): { state: "unsupported" | "needs-install" | "blocked" | "granted" | "prompt"; supported: boolean };
  type Options = { swPath?: string; keyUrl?: string; subscribeUrl?: string; prompt?: boolean; headers?: Record<string, string> };
  export function subscribe(options?: Options): Promise<{ ok: boolean; reason?: string; devices?: number }>;
  export function unsubscribe(options?: { swPath?: string; unsubscribeUrl?: string; headers?: Record<string, string> }): Promise<{ ok: boolean; devices?: number }>;
  export function currentSubscription(options?: { swPath?: string }): Promise<{ endpoint: string } | null>;
}
