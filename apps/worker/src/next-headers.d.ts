// The worker reads only types from the console's lib/auth.ts, whose next/headers import it never runs.
declare module "next/headers";
