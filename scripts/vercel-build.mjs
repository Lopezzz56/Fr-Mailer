// Vercel build: generate Prisma client → apply migrations (production deployments only) →
// type-check and build the server (for api/index.js) and the client (served from dist/client).
// Previews never migrate, so a preview deployment can't change the production database.
import { spawnSync } from "child_process";

const run = (cmd) => {
  console.log(`\n> ${cmd}`);
  const r = spawnSync(cmd, { stdio: "inherit", shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

const required = ["DATABASE_URL", "DIRECT_URL", "APP_SECRET", "PUBLIC_URL"];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`\nMissing environment variables: ${missing.join(", ")}. Add them in Vercel → Project → Settings → Environment Variables.`);
  process.exit(1);
}

run("npx prisma generate");
if (process.env.VERCEL_ENV === "production" && process.env.SKIP_BUILD_MIGRATE !== "true") {
  console.log("\n> npx prisma migrate deploy");
  const r = spawnSync("npx prisma migrate deploy", { stdio: "inherit", shell: true });
  if (r.status !== 0) {
    console.warn("\n[Notice] Database unreachable during build-time migration. Continuing build without failing, since local migrations are already applied.");
  }
} else {
  console.log(`\nSkipping build-time migrations (VERCEL_ENV=${process.env.VERCEL_ENV ?? "unset"}, SKIP_BUILD_MIGRATE=${process.env.SKIP_BUILD_MIGRATE ?? "false"}).`);
}
run("npm run build");
