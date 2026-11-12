import { afterEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import type { NextFunction, Request, Response } from "express";
import { errorHandler } from "./error-handler.js";

function invoke(error: Error) {
  const json = vi.fn();
  const res = {
    status: vi.fn().mockReturnThis(),
    json,
  } as unknown as Response;
  const req = { method: "GET", path: "/api/auth/me" } as Request;

  errorHandler(error, req, res, vi.fn() as NextFunction);
  return { status: vi.mocked(res.status), json };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("errorHandler", () => {
  it("returns a safe service-unavailable message for Prisma connectivity errors", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = new Prisma.PrismaClientKnownRequestError(
      "Can't reach database server at private-db.example:6543",
      {
        code: "P1001",
        clientVersion: "5.22.0",
        meta: { database_host: "private-db.example", database_port: 6543 },
      }
    );

    const { status, json } = invoke(error);

    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: "DATABASE_UNAVAILABLE",
        message: "The service can't reach its database right now. Please try again shortly.",
      },
    });
    expect(JSON.stringify(json.mock.calls)).not.toContain("private-db.example");
  });

  it("returns a safe response when a deployment is missing a database table", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = new Prisma.PrismaClientKnownRequestError(
      "The table `public.user_mailboxes` does not exist in the current database.",
      {
        code: "P2021",
        clientVersion: "5.22.0",
        meta: { table: "public.user_mailboxes" },
      }
    );

    const { status, json } = invoke(error);

    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: "DATABASE_SCHEMA_OUT_OF_DATE",
        message: "The service is updating its database. Please try again shortly.",
      },
    });
    expect(JSON.stringify(json.mock.calls)).not.toContain("user_mailboxes");
  });

  it("does not return unexpected server error messages to clients", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { status, json } = invoke(new Error("private connection string: postgres://user:pass@db.example/app"));

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Something went wrong on our side. Try again in a moment.",
      },
    });
    expect(JSON.stringify(json.mock.calls)).not.toContain("postgres://");
  });
});
