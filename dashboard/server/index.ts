import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  authMiddleware,
  loginHandler,
  logoutHandler,
  statusHandler,
} from "./auth.js";
import tasksRouter from "./routes/tasks.js";
import groupsRouter from "./routes/groups.js";
import containersRouter from "./routes/containers.js";
import logsRouter from "./routes/logs.js";
import projectsRouter from "./routes/projects.js";
import beaconIntelRouter from "./routes/beacon-intel.js";
import mortgageRouter from "./routes/mortgage.js";
import emailUnsubscribeRouter from "./routes/email-unsubscribe.js";
import stravaRouter from "./routes/strava.js";
import garminRouter from "./routes/garmin.js";
import ticketsRouter from "./routes/tickets.js";
import shoppingRouter from "./routes/shopping.js";
import scheduledTasksRouter from "./routes/scheduled-tasks.js";
import fantasyRouter from "./routes/fantasy.js";
import peopleRouter from "./routes/people.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.DASHBOARD_PORT || "3100", 10);

const app = express();

app.use(express.json());
app.use(cookieParser());
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://localhost:3100",
      `http://localhost:${PORT}`,
    ],
    credentials: true,
  })
);

// Auth routes (before middleware)
app.post("/api/auth/login", loginHandler);
app.post("/api/auth/logout", logoutHandler);
app.get("/api/auth/status", statusHandler);

// Public briefings (no auth — meant to be shared)
const briefingsPath = path.resolve(__dirname, "../../data/briefings");
app.use("/briefings", express.static(briefingsPath));

// Protect all API routes. Nothing may be mounted above this line without a
// deliberate, documented reason — Express runs middleware in registration
// order, so an earlier app.use() silently bypasses auth entirely.
app.use("/api/{*splat}", authMiddleware);

// Mount route handlers
app.use(ticketsRouter);
app.use(tasksRouter);
app.use(groupsRouter);
app.use(containersRouter);
app.use(logsRouter);
app.use(projectsRouter);
app.use(beaconIntelRouter);
app.use(mortgageRouter);
app.use(emailUnsubscribeRouter);
app.use(stravaRouter);
app.use(garminRouter);
app.use(shoppingRouter);
app.use(scheduledTasksRouter);
app.use(fantasyRouter);
app.use(peopleRouter);

// In production, serve the built frontend
if (process.env.NODE_ENV === "production") {
  const distPath = path.resolve(__dirname, "../dist");
  // Hashed build assets never change under a name: cache them for a year and
  // send the .br / .gz the build wrote beside each one (vite.config.ts).
  const ASSET_CACHE = "public, max-age=31536000, immutable";
  const ASSET_TYPES: Record<string, string> = {
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
  };
  app.use("/assets", (req, res, next) => {
    const type = ASSET_TYPES[path.extname(req.path)];
    const accepts = String(req.headers["accept-encoding"] ?? "");
    if (!type || req.path.includes("..")) return next();
    for (const [enc, ext] of [
      ["br", ".br"],
      ["gzip", ".gz"],
    ] as const) {
      const file = path.join(distPath, "assets", req.path + ext);
      if (accepts.includes(enc) && fs.existsSync(file)) {
        res.set({ "Content-Type": type, "Content-Encoding": enc, "Cache-Control": ASSET_CACHE, Vary: "Accept-Encoding" });
        return res.sendFile(file);
      }
    }
    next();
  });
  app.use(
    express.static(distPath, {
      setHeaders: (res, file) => {
        if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader("Cache-Control", ASSET_CACHE);
      },
    }),
  );
  app.get("{*splat}", (_req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`NanoClaw Dashboard server running on http://0.0.0.0:${PORT}`);
});
