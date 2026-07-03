"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

export interface PushNotificationScope {
  type: "CARD" | "TOURNAMENT";
  id: string;
  label: string;
}

export type PushToggleResult =
  | "granted"
  | "denied"
  | "unsupported"
  | "unavailable"
  | "error";

const SCOPES_KEY = "ctwe.pushScopes.v1";

function scopeKey(scope: PushNotificationScope) {
  return `${scope.type}:${scope.id}`;
}

function readScopes() {
  if (typeof window === "undefined") return new Set<string>();
  try {
    const value = JSON.parse(localStorage.getItem(SCOPES_KEY) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set<string>();
  }
}

function writeScopes(scopes: Set<string>) {
  localStorage.setItem(SCOPES_KEY, JSON.stringify([...scopes]));
}

function decodeApplicationKey(value: string) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const raw = atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

async function csrfToken() {
  const response = await fetch("/api/auth/me", {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Cannot initialize notification session");
  const body = await response.json() as { csrfToken?: string };
  if (!body.csrfToken) throw new Error("Missing CSRF token");
  return body.csrfToken;
}

async function mutate(path: string, method: "POST" | "DELETE", body: unknown) {
  const token = await csrfToken();
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "X-XSRF-TOKEN": token,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Push subscription failed (${response.status})`);
}

function supported() {
  return typeof window !== "undefined"
    && window.isSecureContext
    && "Notification" in window
    && "serviceWorker" in navigator
    && "PushManager" in window;
}

export function usePushNotifications(scope: PushNotificationScope | null) {
  const key = scope ? scopeKey(scope) : null;
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("unsupported");
  const [savedScopes, setSavedScopes] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const scopes = readScopes();
    setSavedScopes(scopes);
    setPermission(supported() ? Notification.permission : "unsupported");

    // If the browser/OS has removed the underlying subscription, do not leave a misleading active
    // bell in the UI. The server will prune its stale endpoint on the next delivery attempt.
    if (!supported() || Notification.permission !== "granted" || scopes.size === 0) return;
    void navigator.serviceWorker.getRegistration("/notification-sw.js").then(async (registration) => {
      if (!registration || await registration.pushManager.getSubscription()) return;
      writeScopes(new Set());
      setSavedScopes(new Set());
    }).catch(() => undefined);
  }, []);

  const notificationsOn = useMemo(
    () => permission === "granted" && key !== null && savedScopes.has(key),
    [key, permission, savedScopes],
  );

  const enable = useCallback(async (): Promise<PushToggleResult> => {
    if (!scope || !supported()) {
      setPermission("unsupported");
      return "unsupported";
    }
    setPending(true);
    try {
      // Keep this as the first awaited browser action. iOS requires the OS permission prompt to
      // originate directly from the user's tap on the in-app disclosure dialog.
      const nextPermission = Notification.permission === "default"
        ? await Notification.requestPermission()
        : Notification.permission;
      setPermission(nextPermission);
      if (nextPermission === "denied") return "denied";
      if (nextPermission !== "granted") return "error";

      const configResponse = await fetch("/api/public/push/config", {
        credentials: "omit",
        cache: "no-store",
      });
      if (!configResponse.ok) return "unavailable";
      const config = await configResponse.json() as { enabled: boolean; publicKey?: string };
      if (!config.enabled || !config.publicKey) return "unavailable";

      const registration = await navigator.serviceWorker.register("/notification-sw.js", { scope: "/" });
      const existing = await registration.pushManager.getSubscription();
      const subscription = existing ?? await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeApplicationKey(config.publicKey),
      });
      const serialized = subscription.toJSON();
      if (!serialized.endpoint || !serialized.keys?.p256dh || !serialized.keys.auth)
        throw new Error("Browser returned an incomplete push subscription");

      await mutate("/api/public/push/subscriptions", "POST", {
        subscription: {
          endpoint: serialized.endpoint,
          expirationTime: serialized.expirationTime ?? null,
          keys: serialized.keys,
        },
        scopeType: scope.type,
        scopeId: scope.id,
      });
      const scopes = readScopes();
      scopes.add(scopeKey(scope));
      writeScopes(scopes);
      setSavedScopes(scopes);
      return "granted";
    } catch {
      return "error";
    } finally {
      setPending(false);
    }
  }, [scope]);

  const disable = useCallback(async (): Promise<PushToggleResult> => {
    if (!scope || !supported()) return "unsupported";
    setPending(true);
    try {
      const registration = await navigator.serviceWorker.getRegistration("/notification-sw.js");
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        await mutate("/api/public/push/subscriptions", "DELETE", {
          endpoint: subscription.endpoint,
          scopeType: scope.type,
          scopeId: scope.id,
        });
      }
      const scopes = readScopes();
      scopes.delete(scopeKey(scope));
      writeScopes(scopes);
      setSavedScopes(scopes);
      if (scopes.size === 0 && subscription) await subscription.unsubscribe();
      return "granted";
    } catch {
      return "error";
    } finally {
      setPending(false);
    }
  }, [scope]);

  return { notificationsOn, permission, pending, enable, disable };
}
