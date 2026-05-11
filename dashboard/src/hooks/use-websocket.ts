import { useEffect, useRef, useCallback } from "react";
import { useEventStore } from "@/stores/events";
import type { LiveEvent } from "@/types/api";

const WS_URL = import.meta.env.VITE_WS_URL ?? `ws://${window.location.host}/ws/events`;

export function useWebSocket(enabled: boolean = true) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const addEvent = useEventStore((s) => s.addEvent);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const token = localStorage.getItem("astra_token");
    const url = token ? `${WS_URL}?token=${token}` : WS_URL;
    const ws = new WebSocket(url);

    ws.onopen = () => {
      console.log("[WS] Connected to event stream");
    };

    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data as string) as LiveEvent;
        addEvent(event);
      } catch {
        // ignore non-JSON messages
      }
    };

    ws.onclose = () => {
      console.log("[WS] Disconnected, reconnecting in 3s...");
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
