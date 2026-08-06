/**
 * Живые обновления панели через Server-Sent Events.
 * Панель держит одно соединение на вкладку и получает события о заявках,
 * поэтому список обновляется сам — без перезагрузки страницы.
 */

const clients = new Set();
const HEARTBEAT_MS = 25_000;

/** Подключает клиента к потоку событий. Соединение живёт, пока вкладка открыта. */
export function subscribe(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // отключает буферизацию у обратного прокси — иначе события копятся и не доходят
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  // держим сокет открытым: поток длится дольше обычного запроса
  req.socket.setTimeout(0);
  res.write('retry: 5000\n\n');

  const client = { res };
  clients.add(client);

  // комментарий-пинг не даёт прокси закрыть «молчащее» соединение
  const beat = setInterval(() => {
    if (res.writableEnded) return;
    res.write(': ping\n\n');
  }, HEARTBEAT_MS);

  const close = () => {
    clearInterval(beat);
    clients.delete(client);
  };
  req.on('close', close);
  res.on('close', close);
  res.on('error', close);
}

/** Закрывает все потоки — иначе server.close() ждёт их вечно при остановке. */
export function closeAll() {
  for (const client of clients) {
    try {
      client.res.end();
    } catch {
      /* соединение уже оборвано */
    }
  }
  clients.clear();
}

/** Рассылает событие всем открытым панелям. Упавшие соединения отбрасываются. */
export function broadcast(event, data) {
  if (!clients.size) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      if (client.res.writableEnded) {
        clients.delete(client);
        continue;
      }
      client.res.write(frame);
    } catch {
      clients.delete(client);
    }
  }
}
