import { useEffect, useRef, useCallback } from "react";
import { useEventStore } from "@/stores/events";
import type { LiveEvent } from "@/types/api";

// The gateway's WebSocket endpoint is /ws. Scheme follows the page: wss on
// HTTPS (a ws:// socket is blocked as mixed content there), ws on HTTP.
const WS_URL =
  import.meta.env.VITE_WS_URL ??
  `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws`;

export function useWebSocket(enabled: boolean = true) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const addEvent = useEventStore((s) => s.addEvent);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const token = localStorage.getItem("astra_token");
    // Real JWTs only (never the dev-mode mock token) — and passed in the
    // "bearer.<jwt>" subprotocol, not the query string, so the token does
    // not end up in proxy/access logs or browser history.
    if (!token || token.split(".").length !== 3) return;
    const ws = new WebSocket(WS_URL, [`bearer.${token}`]);

    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data as string) as LiveEvent;
        addEvent(event);
      } catch {
        // ignore non-JSON messages
      }
    };

    ws.onclose = (e) => {
      // 4001/4003: the gateway rejected the token — retrying cannot succeed.
      if (e.code === 4001 || e.code === 4003) return;
      reconnectTimer.current = setTimeout(connect, 3000);
    };

    ws.onerror = () => {
      ws.close();
    };

    wsRef.current = ws;
  }, [addEvent]);

  useEffect(() => {
    if (!enabled) {
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
      wsRef.current = null;
      return;
    }
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect, enabled]);

  return wsRef;
}
