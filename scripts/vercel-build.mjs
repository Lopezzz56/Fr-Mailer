// Vercel build: generate Prisma client → apply migrations (production deployments only) →
// type-check and build the server (for api/index.js) and the client (served from dist/client).
// Previews never migrate, so a preview deployment can't change the production database.
import "dotenv/config";
import { spawnSync } from "child_process";

const run = (cmd) => {
  console.log(`\n> ${cmd}`);
  const r = spawnSync(cmd, { stdio: "inherit", shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

// Automatic environment fallbacks for Vercel deployment:
if (!process.env.PUBLIC_URL) {
  process.env.PUBLIC_URL = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL.replace(/\/+$/, "")}`
    : "https://fr-mailer.vercel.app";
}

for (const name of ["DATABASE_URL", "APP_SECRET"]) {
  if (!process.env[name]) {
    console.error(`\nMissing environment variable: ${name}.\nAdd it in Vercel → Project → Settings → Environment Variables.`);
    process.exit(1);
  }
}

run("npx prisma generate");
if (process.env.VERCEL_ENV === "production" && process.env.SKIP_BUILD_MIGRATE !== "true") {
  if (!process.env.DIRECT_URL) {
    console.error("\nMissing environment variable: DIRECT_URL. Set a reachable direct or session-pooler database URL for production migrations.");
    process.exit(1);
  }
  console.log("\n> npx prisma migrate deploy");
  const r = spawnSync("npx prisma migrate deploy", { stdio: "inherit", shell: true });
  if (r.status !== 0) {
    console.error("\nProduction database migrations failed. The deployment was stopped to avoid running application code against an outdated schema.");
    process.exit(r.status ?? 1);
  }
} else {
  console.log(
    `\nSkipping build-time migrations (VERCEL_ENV=${process.env.VERCEL_ENV ?? "unset"}, SKIP_BUILD_MIGRATE=${process.env.SKIP_BUILD_MIGRATE ?? "false"}).`
  );
}
run("npm run build");
