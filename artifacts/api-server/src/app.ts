import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// Serve the FLICO static app (index.html at workspace root) at "/".
// This is purely for local preview — the real deployment uses Cloudflare Pages.
// __dirname in the built file = artifacts/api-server/dist/
// Three levels up → workspace root.
const workspaceRoot = path.resolve(__dirname, "../../../");
app.use(express.static(workspaceRoot, { index: "index.html" }));

export default app;
