import { useEffect, useRef, useState, useCallback } from 'react';
import * as api from '../api/client';

export type WsStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export interface WsMessage {
  type: string;
  [key: string]: unknown;
}

interface UseWebSocketResult {
  lastMessage: WsMessage | null;
  status: WsStatus;
  reconnect: () => void;
  send: (data: object) => void;
}

const MAX_RETRIES = 5;
const BASE_DELAY = 1000; // 1s, 2s, 4s, 8s, 16s

export function useWebSocket(
  code: string | null,
  playerId: string | null,
  token: string | null,
  onTokenRefresh?: (newToken: string) => void,
): UseWebSocketResult {
  const [lastMessage, setLastMessage] = useState<WsMessage | null>(null);
  const [status, setStatus] = useState<WsStatus>('disconnected');
  const wsRef = useRef<WebSocket | null>(null);
  const retriesRef = useRef(0);
  const closedIntentionallyRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const rejoinAttemptedRef = useRef(false);

  // Reset lastMessage when connection parameters change to prevent stale messages
  // from a previous session being processed by a new one
  const prevCodeRef = useRef(code);
  if (code !== prevCodeRef.current) {
    prevCodeRef.current = code;
    setLastMessage(null);
  }

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    if (!code || !playerId || !tokenRef.current) return;

    closedIntentionallyRef.current = false;
    setStatus('connecting');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const backendHost = import.meta.env.VITE_BACKEND_HOST || window.location.host;
    const url = `${protocol}//${backendHost}/api/lobby/ws/${code}?player_id=${playerId}&token=${tokenRef.current}`;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('connected');
      retriesRef.current = 0;
      rejoinAttemptedRef.current = false;
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as WsMessage;
        setLastMessage(data);
      } catch {
        // Ignore non-JSON messages
      }
    };

    ws.onclose = (event) => {
      wsRef.current = null;
      if (closedIntentionallyRef.current) {
        setStatus('disconnected');
        setLastMessage(null); // Clear stale messages on intentional disconnect
        return;
      }

      // 403 / 4003 = invalid token — try to rejoin for a fresh token
      const isAuthError = event.code === 4003 || event.code === 1006;
      if (isAuthError && !rejoinAttemptedRef.current && code && playerId) {
        rejoinAttemptedRef.current = true;
        setStatus('connecting');
        api.rejoinLobby(code, playerId).then((result) => {
          tokenRef.current = result.token;
          onTokenRefresh?.(result.token);
          retriesRef.current = 0;
          // Reconnect with the fresh token
          reconnectTimerRef.current = setTimeout(() => {
            reconnectTimerRef.current = null;
            connect();
          }, 500);
        }).catch(() => {
          // Rejoin failed (lobby gone, etc.) — fall through to normal retry
          rejoinAttemptedRef.current = true;
          if (retriesRef.current < MAX_RETRIES) {
            const delay = BASE_DELAY * Math.pow(2, retriesRef.current);
            retriesRef.current += 1;
            setStatus('connecting');
            reconnectTimerRef.current = setTimeout(() => {
              reconnectTimerRef.current = null;
              connect();
            }, delay);
          } else {
            setStatus('error');
          }
        });
        return;
      }

      // Auto-reconnect with exponential backoff
      if (retriesRef.current < MAX_RETRIES) {
        const delay = BASE_DELAY * Math.pow(2, retriesRef.current);
        retriesRef.current += 1;
        setStatus('connecting');
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          connect();
        }, delay);
      } else {
        setStatus('error');
      }
    };

    ws.onerror = () => {
      // onclose will fire after onerror
    };
  }, [code, playerId, onTokenRefresh]);

  const send = useCallback((data: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  const reconnect = useCallback(() => {
    retriesRef.current = 0;
    rejoinAttemptedRef.current = false;
    clearReconnectTimer();
    if (wsRef.current) {
      closedIntentionallyRef.current = true;
      wsRef.current.close();
      wsRef.current = null;
    }
    connect();
  }, [connect, clearReconnectTimer]);

  useEffect(() => {
    connect();
    return () => {
      closedIntentionallyRef.current = true;
      clearReconnectTimer();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect, clearReconnectTimer]);

  return { lastMessage, status, reconnect, send };
}
