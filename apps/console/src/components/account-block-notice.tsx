// The account's block, said plainly where a person is checking answers: the deployment page and
// Review (fix cycle 7d). Nothing while there's no block, or when the database can't say.

import { accountBlock } from "@/lib/account-block.ts";
import { blockNotice } from "@/lib/ask-refusal.ts";
import { db } from "@/lib/db.ts";

export async function AccountBlockNotice() {
  const blocked = await accountBlock(db()).catch(() => undefined);
  if (!blocked) return null;
  return (
    <p className="notice" data-tone="critical" role="alert">
      {blockNotice(blocked.state)}
    </p>
  );
}
