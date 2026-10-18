// A throwaway SMTP sink for the password-reset test (P5-01 review, ADR
// 0060): accepts every message and keeps it in memory. SMTP is deployment
// config (P13-01) and the realm file sets none; the test points the
// imported realm at this sink through the admin API.
import { createServer, type Socket } from "node:net";

export interface SmtpSink {
  readonly port: number;
  readonly messages: string[];
  close(): Promise<void>;
}

export async function startSmtpSink(): Promise<SmtpSink> {
  const messages: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    let data: string[] | undefined;
    const reply = (line: string) => socket.write(`${line}\r\n`);
    reply("220 bricx-test-sink");
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let end = buffer.indexOf("\r\n");
      while (end !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        end = buffer.indexOf("\r\n");
        if (data !== undefined) {
          if (line === ".") {
            messages.push(data.join("\n"));
            data = undefined;
            reply("250 ok");
          } else {
            data.push(line);
          }
          continue;
        }
        const command = line.slice(0, 4).toUpperCase();
        if (command === "DATA") {
          data = [];
          reply("354 end with .");
        } else if (command === "QUIT") {
          reply("221 bye");
          socket.end();
        } else {
          reply("250 ok");
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the SMTP sink has no port");
  }
  return {
    port: address.port,
    messages,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => {
          resolve();
        });
      }),
  };
}
