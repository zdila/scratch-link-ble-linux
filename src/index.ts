import { createServer } from "https";
import { readFileSync } from "fs";
import { WebSocketServer } from "ws";
import { initBle } from "./ble";
import { Buffer } from "buffer";
import { intelinoBufferToJson } from "./intelino";
import { debug } from "./debug";

initBle()
  .then(({ createSession }) => {
    const isIntelino = process.argv.includes("--intelino");

    const server = createServer(
      {
        cert: readFileSync("cert/scratch-device-manager.cer"),
        key: readFileSync("cert/scratch-device-manager.key"),
      },
      (req, res) => {
        res.writeHead(200);
        res.end("OK");
      }
    );

    const wss = new WebSocketServer({ server });

    server.listen(20110);

    wss.on("connection", (ws) => {
      debug("WebSocket connection");

      const session = createSession();

      const send = (data: Record<string, unknown>) => {
        debug("RPC Sending:", data);

        if (ws.readyState !== ws.OPEN) {
          console.warn("Can't send, WeboSocket is not open");

          return;
        }

        return ws.send(
          JSON.stringify({ jsonrpc: "2.0", ...data }),
          {},
          (err) => {
            if (err) {
              console.error("Error sending data to WebSocket:", err);
            }
          }
        );
      };

      ws.on("message", (data) => {
        const { id, method, params } = JSON.parse(data.toString("utf8"));

        debug("RPC Received:", { id, method, params });

        const reply = (data: Record<string, unknown>) => {
          return send({ id, ...data });
        };

        const replyError = (err: unknown) => {
          console.error(err);

          return reply({ error: { code: -32603, message: String(err) } });
        };

        switch (method) {
          case "getVersion":
            reply({ result: { protocol: "1.3" } });

            break;

          case "discover":
            session
              .discover(params.filters)
              .then(() => reply({ result: null }), replyError);

            break;

          case "connect":
            session
              .connect(params.peripheralId)
              .then(() => reply({ result: null }), replyError);

            break;

          case "write":
            {
              const msg =
                params.encoding === "base64"
                  ? [...Buffer.from(params.message, "base64").values()]
                  : params.message;

              session
                .write(
                  params.serviceId,
                  params.characteristicId,
                  msg,
                  params.withResponse
                )
                .then(() => reply({ result: msg.length }), replyError);
            }

            break;

          case "read":
            session
              .read(
                params.serviceId,
                params.characteristicId,
                params.startNotifications
              )
              .then(
                (result) =>
                  reply({
                    result: result.toString("base64"),
                    encoding: "base64",
                  }),
                replyError
              );

            break;

          case "startNotifications":
            session
              .startNotifications(params.serviceId, params.characteristicId)
              .then(() => reply({ result: null }), replyError);

            break;

          case "stopNotifications":
            session
              .stopNotifications(params.serviceId, params.characteristicId)
              .then(
                () => reply({ result: null }),
                (err: unknown) => reply({ error: String(err) })
              );

            break;

          case "getServices":
            reply({ result: session.getServices() });

            break;

          case "getCharacteristics": {
            reply({
              result: session.getCharacteristics(params.serviceId),
            });

            break;
          }

          default:
            console.error("unknown method");

            reply({
              error: {
                code: -32601,
                message: "Method not found",
              },
            });

            break;
        }
      });

      session.on("disconnect", () => {
        ws.close();
      });

      ws.on("close", () => {
        debug("WebSocket connection closed");

        session.close();
      });

      session.on("discover", (params) => {
        send({
          method: "didDiscoverPeripheral",
          params,
        });
      });

      session.on(
        "characteristicChange",
        ({ serviceId, characteristicId, message }) => {
          if (isIntelino) {
            console.log(
              intelinoBufferToJson(
                new DataView(
                  message.buffer,
                  message.byteOffset,
                  message.byteLength
                )
              )
            );
          }

          send({
            method: "characteristicDidChange",
            params: {
              serviceId,
              characteristicId,
              message: message.toString("base64"),
              encoding: "base64",
            },
          });
        }
      );
    });
  })
  .catch((err) => {
    console.error(err);
  });
