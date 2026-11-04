// After signing out: a plain page (the console itself would send you straight to sign-in).

export function GET() {
  return new Response(
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Signed out · Launchpad</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:560px;margin:15vh auto;padding:0 16px;color:#111}a{color:#2b2bb2}</style></head><body><h1>Signed out</h1><p><a href="/auth/login">Sign in again</a></p></body></html>',
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}
