import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { authMiddleware, loginHandler, logoutHandler, statusHandler, } from "./auth.js";
import tasksRouter from "./routes/tasks.js";
import groupsRouter from "./routes/groups.js";
import containersRouter from "./routes/containers.js";
import logsRouter from "./routes/logs.js";
import projectsRouter from "./routes/projects.js";
import beaconIntelRouter from "./routes/beacon-intel.js";
import mortgageRouter from "./routes/mortgage.js";
import emailUnsubscribeRouter from "./routes/email-unsubscribe.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.DASHBOARD_PORT || "3100", 10);
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(cors({
    origin: [
        "http://localhost:5173",
        "http://localhost:3100",
        `http://localhost:${PORT}`,
    ],
    credentials: true,
}));
// Auth routes (before middleware)
app.post("/api/auth/login", loginHandler);
app.post("/api/auth/logout", logoutHandler);
app.get("/api/auth/status", statusHandler);
// Protect all other API routes
app.use("/api/{*splat}", authMiddleware);
// Mount route handlers
app.use(tasksRouter);
app.use(groupsRouter);
app.use(containersRouter);
app.use(logsRouter);
app.use(projectsRouter);
app.use(beaconIntelRouter);
app.use(mortgageRouter);
app.use(emailUnsubscribeRouter);
// In production, serve the built frontend
if (process.env.NODE_ENV === "production") {
    const distPath = path.resolve(__dirname, "../dist");
    app.use(express.static(distPath));
    app.get("{*splat}", (_req, res) => {
        res.sendFile(path.join(distPath, "index.html"));
    });
}
app.listen(PORT, "0.0.0.0", () => {
    console.log(`NanoClaw Dashboard server running on http://0.0.0.0:${PORT}`);
});
