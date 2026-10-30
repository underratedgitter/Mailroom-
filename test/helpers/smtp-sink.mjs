// Accepts SMTP and captures messages, so tests can prove real delivery
// without touching a network mailbox.
import net from 'node:net';

export function startSmtpSink() {
  const messages = [];
  const connections = new Set();

  const server = net.createServer((sock) => {
    connections.add(sock);
    sock.on('close', () => connections.delete(sock));
    sock.on('error', () => {});

    let buffer = '';
    let inData = false;
    let data = '';
    let envelope = { from: null, to: [] };

    sock.write('220 sink ESMTP\r\n');

    sock.on('data', (chunk) => {
      buffer += chunk.toString('binary');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          data += buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          messages.push({ ...envelope, data });
          envelope = { from: null, to: [] };
          data = '';
          sock.write('250 2.0.0 OK queued\r\n');
          continue;
        }

        const idx = buffer.indexOf('\r\n');
        if (idx === -1) return;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const verb = line.slice(0, 4).toUpperCase();

        if (verb === 'EHLO') sock.write('250-sink\r\n250-8BITMIME\r\n250 OK\r\n');
        else if (verb === 'HELO') sock.write('250 sink\r\n');
        else if (verb === 'MAIL') {
          envelope.from = line.replace(/^MAIL FROM:\s*/i, '').trim();
          sock.write('250 2.1.0 OK\r\n');
        } else if (verb === 'RCPT') {
          envelope.to.push(line.replace(/^RCPT TO:\s*/i, '').trim());
          sock.write('250 2.1.5 OK\r\n');
        } else if (verb === 'DATA') {
          sock.write('354 go ahead\r\n');
          inData = true;
        } else if (verb === 'QUIT') {
          sock.write('221 bye\r\n');
          sock.end();
          return;
        } else if (verb === 'AUTH') {
          sock.write('503 auth not offered\r\n');
        } else {
          sock.write('250 2.0.0 OK\r\n');
        }
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        messages,
        close: () => new Promise((done) => {
          for (const sock of connections) sock.destroy();
          server.close(() => done());
        }),
      });
    });
  });
}

export async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}
