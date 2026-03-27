import { Request, Response, NextFunction } from "express";
import crypto from "crypto";

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;

if (!DASHBOARD_PASSWORD) {
  console.error(
    "DASHBOARD_PASSWORD env var is required. Set it before starting the dashboard server."
  );
  process.exit(1);
}

const validTokens = new Set<string>();

export function loginHandler(req: Request, res: Response) {
  try {
    const { password } = req.body as { password?: string };

    if (!password || password !== DASHBOARD_PASSWORD) {
      res.status(401).json({ error: "Invalid password" });
      return;
    }

    const token = crypto.randomBytes(32).toString("hex");
    validTokens.add(token);

    res.cookie("dashboard_token", token, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    res.json({ authenticated: true });
  } catch (err) {
    res.status(500).json({ error: "Login failed" });
  }
}

export function logoutHandler(req: Request, res: Response) {
  try {
    const token = req.cookies?.dashboard_token;
    if (token) {
      validTokens.delete(token);
    }
    res.clearCookie("dashboard_token");
    res.json({ authenticated: false });
  } catch (err) {
    res.status(500).json({ error: "Logout failed" });
  }
}

export function statusHandler(req: Request, res: Response) {
  const token = req.cookies?.dashboard_token;
  const authenticated = !!token && validTokens.has(token);
  res.json({ authenticated });
}

export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  // Skip auth for login, logout, and status endpoints
  if (
    req.path === "/api/auth/login" ||
    req.path === "/api/auth/logout" ||
    req.path === "/api/auth/status"
  ) {
    next();
    return;
  }

  const token = req.cookies?.dashboard_token;

  if (!token || !validTokens.has(token)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}
